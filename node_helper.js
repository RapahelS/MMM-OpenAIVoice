// node_helper.js – Finale, stabile Version mit korrekter Architektur und API-Nutzung
"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");

module.exports = NodeHelper.create({
  init() {
    this.cfg = {};
    this.openai = null;
    this.isProcessing = false;
    this.previousResponseId = null;
    this.conversationTimeout = null;
  },

  socketNotificationReceived(type, payload) {
    if (type === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      this.debug = !!this.cfg.debug;
      if (!this.cfg.openAiKey) {
        return this.error("OpenAI API Key ist nicht in der config.js gesetzt!");
      }
      try {
        this.openai = new OpenAI({ apiKey: this.cfg.openAiKey });
        this.log("Initialisierung erfolgreich.");
      } catch (e) {
        this.error("OpenAI-Initialisierung fehlgeschlagen:", e.message);
      }
      return;
    }

    if (type === "OPENAIVOICE_PROCESS_AUDIO" && payload?.filePath) {
      if (this.isProcessing)
        return this.log("Ignoriere Audio, Anfrage läuft bereits.");

      this.isProcessing = true;
      this.stopConversationTimeout();
      this.handleAudioPipeline(payload.filePath).finally(() => {
        this.isProcessing = false;
      });
    }
  },

  async handleAudioPipeline(wavPath) {
    try {
      const userText = await this.speechToText(wavPath);
      if (!userText) {
        this.log("Kein Text erkannt, starte Konversations-Loop neu.");
        return this.startConversationLoop();
      }

      this.send("USER_TRANSCRIPTION", userText);
      const botResponseText = await this.getBotResponseWithTools(userText);

      this.send("BOT_CHUNK", botResponseText);
      await this.playTextAsSpeech(botResponseText);
      this.startConversationLoop();
    } catch (err) {
      this.error(err.message || "Unbekannter Fehler in der Pipeline.");
      this.endConversation();
    } finally {
      fs.unlink(
        wavPath,
        (e) => e && this.log("Fehler beim Löschen der WAV-Datei:", e.message)
      );
    }
  },

  async speechToText(path) {
    // Diese Funktion bleibt unverändert und ist bereits korrekt.
    const t0 = Date.now();
    try {
      const { text } = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(path),
        model: this.cfg.transcribeModel,
      });
      this.log(`STT ⏱ ${Date.now() - t0} ms →`, text.trim());
      return text.trim();
    } catch (e) {
      this.error(`STT Fehler: ${e.message}`);
      return "";
    }
  },

  async getBotResponseWithTools(userText) {
    this.log("Frage an Responses API mit Web-Suche...");
    try {
      const response = await this.openai.responses.create({
        model: this.cfg.model,
        instructions:
          "Du bist ein lustiger Assistant der Hinter dem Spiegel im Bad sitzt und hilfst. Halte dich kurz und witzig.",
        input: userText,
        previous_response_id: this.previousResponseId,
        tools: [{ type: "web_search" }],
        stream: false,
        store: false, // Beste Praxis: Antworten nicht unnötig speichern
      });

      this.previousResponseId = response.id;
      // FIX: Die korrekte Eigenschaft `output_text` verwenden.
      const text = response.output_text;

      if (!text) {
        this.log(
          "API hat leeren Text zurückgegeben, vermutlich weil die Anfrage unklar war."
        );
        return "Ich bin mir nicht sicher, wie ich darauf antworten soll. Kannst du es anders formulieren?";
      }

      this.log("Antwort von Responses API erhalten:", text.trim());
      return text.trim();
    } catch (e) {
      this.error(`Fehler bei der Anfrage an die Responses API: ${e.message}`);
      this.previousResponseId = null;
      return "Entschuldigung, es gab ein Problem mit meinen Werkzeugen.";
    }
  },

  async playTextAsSpeech(text) {
    if (!text) return;
    this.log(`Spiele Audio für: "${text}"`);
    try {
      const speech = await this.openai.audio.speech.create({
        model: this.cfg.ttsModel,
        voice: this.cfg.voice,
        input: text,
        instructions:
          "Spreche in einem positiven, freundlichen und lustigen Ton",
        response_format: "pcm",
      });
      const audioBuffer = Buffer.from(await speech.arrayBuffer());
      await this.playAudioBuffer(audioBuffer);
    } catch (e) {
      this.error(`Fehler bei der TTS-Erstellung: ${e.message}`);
    }
  },

  playAudioBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const player = spawn("aplay", [
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
      ]);
      player.on("close", resolve).on("error", reject);
      player.stdin.end(buffer);
    });
  },

  startConversationLoop() {
    this.log("Sende Anfrage an Frontend, um Mikrofon zu aktivieren...");
    // FIX: Sendet Socket-Nachricht an das Frontend. Das ist der korrekte Weg.
    this.sendSocketNotification("HOTWORD_CONTROL", { action: "ACTIVATE" });
    this.startConversationTimeout();
  },

  startConversationTimeout() {
    this.stopConversationTimeout();
    this.log(`Konversation wird in ${this.cfg.silenceMs / 1000}s beendet.`);
    // FIX: Arrow-Function `() => {}` erhält den 'this'-Kontext korrekt.
    this.conversationTimeout = setTimeout(() => {
      this.endConversation();
    }, this.cfg.silenceMs);
  },

  stopConversationTimeout() {
    if (this.conversationTimeout) clearTimeout(this.conversationTimeout);
    this.conversationTimeout = null;
  },

  endConversation() {
    this.log("Sende Anfrage an Frontend, um Mikrofon zu deaktivieren.");
    // FIX: Sendet Socket-Nachricht an das Frontend.
    this.sendSocketNotification("HOTWORD_CONTROL", { action: "DEACTIVATE" });
    this.previousResponseId = null;
    this.send("CONVERSATION_END");
  },

  send(tag, txt) {
    this.sendSocketNotification(`OPENAIVOICE_${tag}`, txt);
  },
  log(...args) {
    if (this.debug) console.log("[MMM-OpenAIVoice]", ...args);
  },
  error(...args) {
    console.error("[MMM-OpenAIVoce ERROR]", ...args);
    this.send("ERROR", args[0]?.message || JSON.stringify(args[0]));
  },
});
