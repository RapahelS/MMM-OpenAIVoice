// node_helper.js – Optimierte Streaming-Pipeline für MMM-OpenAIVoice
"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");
require("dotenv").config(); // Lädt API-Key aus .env im Helper-Verzeichnis

// Einfache Satzgrenzen-Erkennung für flüssiges Streaming
const SENTENCE_END_REGEX = /[.!?]\s|[\n\r]/;

module.exports = NodeHelper.create({
  init() {
    this.conv = [];
    this.prevId = undefined;
    this.lastInteractionTimestamp = 0;
    this.isProcessing = false;
    this.cfg = {};
    this.openai = null;
  },

  socketNotificationReceived(type, payload) {
    if (type === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      this.debug = !!this.cfg.debug;
      try {
        this.openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY || this.cfg.openAiKey,
        });
        this.log("Initialisierung erfolgreich. Modell:", this.cfg.model);
      } catch (e) {
        this.error("OpenAI-Initialisierung fehlgeschlagen:", e.message);
      }
      return;
    }

    if (type === "OPENAIVOICE_PROCESS_AUDIO" && payload?.filePath) {
      if (this.isProcessing) {
        this.log(
          "Ignoriere Audio, da bereits eine Anfrage in Bearbeitung ist."
        );
        return;
      }
      this.isProcessing = true;
      this.handleAudioPipeline(payload.filePath).finally(() => {
        this.isProcessing = false;
        this.lastInteractionTimestamp = Date.now();
      });
    }
  },

  async handleAudioPipeline(wavPath) {
    try {
      // Kontext zurücksetzen, wenn zu lange nichts gesagt wurde
      if (Date.now() - this.lastInteractionTimestamp > this.cfg.silenceMs) {
        this.log("Stille-Timeout erreicht, setze Konversation zurück.");
        this.conv = [];
        this.prevId = undefined;
      }

      /* 1. STT: Sprache zu Text */
      const userText = await this.speechToText(wavPath);
      if (!userText) {
        this.log("Kein Text erkannt.");
        return;
      }
      this.send("USER_TRANSCRIPTION", userText);
      this.conv.push({ role: "user", content: userText });

      /* 2. & 3. ECHTE STREAMING-PIPELINE: LLM -> TTS -> Player */
      await this.processLlmAndTtsStream(userText);
    } catch (err) {
      this.error(err.message || "Ein unbekannter Fehler ist aufgetreten.");
    } finally {
      // Aufräumen der temporären WAV-Datei
      fs.unlink(
        wavPath,
        (e) => e && this.log("Fehler beim Löschen der WAV-Datei:", e.message)
      );
    }
  },

  async speechToText(path) {
    const t0 = Date.now();
    try {
      const { text } = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(path),
        model: "gpt-4o-mini-transcribe", // Das ist die beste Wahl für schnelle Transkription
      });
      this.log(`STT ⏱ ${Date.now() - t0} ms →`, text.trim());
      return text.trim();
    } catch (e) {
      this.error(`STT Fehler: ${e.message}`);
      return "";
    }
  },

  async processLlmAndTtsStream(userText) {
    this.send("BOT_START"); // Signal an UI, dass die Bot-Antwort beginnt

    // Player (aplay) wird einmalig gestartet und wartet auf Audio-Daten via stdin
    const player = this.createAudioPlayer();

    // Text-Puffer für Sätze
    let sentenceBuffer = "";

    try {
      // Die Responses-API ist hier die korrekte Wahl für Agenten-Logik
      const stream = await this.openai.responses.create({
        model: this.cfg.model,
        input: userText, // Nur die letzte Eingabe senden
        previous_response_id: this.prevId, // Den Verlauf über die ID steuern
        stream: true,
        // Werkzeuge wie Web Search könnten hier aktiviert werden:
        // tools: [{ type: "web_search" }],
      });

      this.log("Pipeline gestartet mit Responses-API.");

      for await (const event of stream) {
        if (event.type === "content.delta") {
          const delta = event.content[0].text;
          if (!delta) continue;

          // Sende Chunk sofort an die UI für den "Tipp-Effekt"
          this.send("BOT_CHUNK", delta);
          sentenceBuffer += delta;

          // Wenn ein Satzende erreicht ist, generiere und spiele den Ton ab
          if (SENTENCE_END_REGEX.test(sentenceBuffer)) {
            await this.streamTextToPlayer(sentenceBuffer.trim(), player);
            sentenceBuffer = ""; // Puffer für den nächsten Satz zurücksetzen
          }
        }
        // Wichtig: Die neue ID für die nächste Konversationsrunde speichern
        if (event.type === "response") {
          this.prevId = event.response.id;
        }
      }

      // Den restlichen Text im Puffer (falls kein Satzende am Schluss) auch noch sagen
      if (sentenceBuffer.trim()) {
        await this.streamTextToPlayer(sentenceBuffer.trim(), player);
      }

      // Gesamte Bot-Antwort im Kontext für die nächste Runde speichern
      const fullResponse = stream.response.content[0].text;
      this.conv.push({ role: "assistant", content: fullResponse });
    } catch (e) {
      this.error(`LLM/TTS Stream Fehler: ${e.status || ""} ${e.message}`);
      // Fallback-Nachricht abspielen
      await this.streamTextToPlayer(
        "Entschuldigung, ein Fehler ist aufgetreten.",
        player
      );
    } finally {
      // Wichtig: Den Player-Prozess sauber beenden, wenn alles gesagt wurde
      player.stdin.end();
      this.send("BOT_END"); // Signal an UI, dass die Antwort komplett ist
      this.log("Pipeline beendet.");
    }
  },

  async streamTextToPlayer(text, player) {
    if (!text) return;
    this.log(`Spreche Satz: "${text}"`);
    try {
      const ttsStream = await this.openai.audio.speech.create({
        model: this.cfg.ttsModel,
        voice: this.cfg.voice,
        input: text,
        response_format: "pcm_s16le", // PCM ist ideal für Raspberry Pi: kein Dekodierungs-Overhead
      });

      // Pipe den Audio-Stream direkt in den Player
      // { end: false } verhindert, dass der Player nach dem ersten Satz schließt
      ttsStream.body.pipe(player.stdin, { end: false });

      // Warten, bis dieser Audio-Chunk vollständig in den Player geschrieben wurde
      await new Promise((resolve) => ttsStream.body.on("end", resolve));
    } catch (e) {
      this.error(`TTS Fehler für Text "${text}": ${e.message}`);
    }
  },

  createAudioPlayer() {
    // PCM-Format ist für den Pi am performantesten, da es roh ist
    // und keine CPU-lastige Dekodierung wie bei MP3 benötigt.
    const args = [
      "-q", // leise, keine Statusmeldungen
      "-D",
      this.cfg.playbackDevice, // Audiogerät
      "-t",
      "raw", // Dateityp
      "-f",
      "S16_LE", // Format: Signed 16-bit Little-Endian (Standard für pcm_s16le)
      "-r",
      "24000", // Abtastrate: 24kHz ist Standard für OpenAI TTS
      "-c",
      "1", // Kanäle: Mono
    ];
    const player = spawn("aplay", args);
    player.on("error", (err) => this.error("aplay Fehler:", err.message));
    player.stderr.on("data", (data) => this.error(`aplay stderr: ${data}`));
    return player;
  },

  /* ------------------- Utils ----------------------- */
  send(tag, txt) {
    this.sendSocketNotification(`OPENAIVOICE_${tag}`, txt);
  },
  log(...args) {
    if (this.debug) console.log("[MMM-OpenAIVoice]", ...args);
  },
  error(...args) {
    console.error("[MMM-OpenAIVoice ERROR]", ...args);
    this.send("ERROR", args[0]?.message || JSON.stringify(args[0]));
  },
});
