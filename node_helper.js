// node_helper.js – Finale, korrigierte Version
"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");

const SENTENCE_END_REGEX = /[.!?]\s|[\n\r]/;

module.exports = NodeHelper.create({
  // init() und socketNotificationReceived() bleiben unverändert
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
      if (!this.cfg.openAiKey) {
        this.error("OpenAI API Key ist nicht in der config.js gesetzt!");
        return;
      }
      try {
        this.openai = new OpenAI({ apiKey: this.cfg.openAiKey });
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

  // handleAudioPipeline() und speechToText() bleiben unverändert
  async handleAudioPipeline(wavPath) {
    try {
      if (Date.now() - this.lastInteractionTimestamp > this.cfg.silenceMs) {
        this.log("Stille-Timeout erreicht, setze Konversation zurück.");
        this.conv = [];
        this.prevId = undefined;
      }
      const userText = await this.speechToText(wavPath);
      if (!userText) {
        this.log("Kein Text erkannt.");
        return;
      }
      this.send("USER_TRANSCRIPTION", userText);
      await this.processLlmAndTtsStream(userText);
    } catch (err) {
      this.error(err.message || "Ein unbekannter Fehler ist aufgetreten.");
    } finally {
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
        model: this.cfg.transcribeModel,
      });
      this.log(
        `STT (${this.cfg.transcribeModel}) ⏱ ${Date.now() - t0} ms →`,
        text.trim()
      );
      return text.trim();
    } catch (e) {
      this.error(`STT Fehler: ${e.message}`);
      return "";
    }
  },

  // KORRIGIERTE FUNKTION
  async processLlmAndTtsStream(userText) {
    this.send("BOT_START");
    const player = this.createAudioPlayer();
    let sentenceBuffer = "";
    let fullResponseText = ""; // FIX 1: Variable zum Sammeln der Antwort

    try {
      const stream = await this.openai.responses.create({
        model: this.cfg.model,
        input: userText,
        previous_response_id: this.prevId,
        stream: true,
      });

      this.log("Pipeline gestartet mit Responses-API.");

      for await (const event of stream) {
        if (event.type === "content.delta") {
          const delta = event.content[0].text;
          if (!delta) continue;

          fullResponseText += delta; // FIX 1: Antwort hier zusammensetzen
          this.send("BOT_CHUNK", delta);
          sentenceBuffer += delta;

          if (SENTENCE_END_REGEX.test(sentenceBuffer)) {
            await this.streamTextToPlayer(sentenceBuffer.trim(), player);
            sentenceBuffer = "";
          }
        }
        if (event.type === "response") {
          this.prevId = event.response.id;
        }
      }

      if (sentenceBuffer.trim()) {
        await this.streamTextToPlayer(sentenceBuffer.trim(), player);
      }

      // FIX 1: Die selbst zusammengesetzte Antwort für den Kontext verwenden
      this.conv.push({ role: "user", content: userText });
      this.conv.push({ role: "assistant", content: fullResponseText });
    } catch (e) {
      this.error(`LLM/TTS Stream Fehler: ${e.message}`);
      await this.streamTextToPlayer(
        "Entschuldigung, ein Fehler ist aufgetreten.",
        player
      );
    } finally {
      player.stdin.end();
      this.send("BOT_END");
      this.log("Pipeline beendet.");
    }
  },

  // KORRIGIERTE FUNKTION
  async streamTextToPlayer(text, player) {
    if (!text) return;
    this.log(`Spreche Satz: "${text}"`);
    try {
      const ttsStream = await this.openai.audio.speech.create({
        model: this.cfg.ttsModel,
        voice: this.cfg.voice,
        input: text,
        // FIX 2: Korrektes, von der API unterstütztes Format verwenden
        response_format: "pcm",
      });
      ttsStream.body.pipe(player.stdin, { end: false });
      await new Promise((resolve) => ttsStream.body.on("end", resolve));
    } catch (e) {
      this.error(`TTS Fehler für Text "${text}": ${e.message}`);
    }
  },

  // createAudioPlayer() und Utils bleiben unverändert
  createAudioPlayer() {
    const args = [
      "-q",
      "-D",
      this.cfg.playbackDevice,
      "-t",
      "raw",
      "-f",
      "S16_LE",
      "-r",
      "24000",
      "-c",
      "1",
    ];
    const player = spawn("aplay", args);
    player.on("error", (err) => this.error("aplay Fehler:", err.message));
    player.stderr.on("data", (data) => this.error(`aplay stderr: ${data}`));
    return player;
  },

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
