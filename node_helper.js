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
    this.conversation = [];
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
      if (this.isProcessing) {
        return this.log("Ignoriere Audio, Anfrage läuft bereits.");
      }
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
        this.startConversationLoop();
        return;
      }

      this.send("USER_TRANSCRIPTION", userText);
      this.conversation.push({ role: "user", content: userText });

      const botResponseText = await this.getBotResponse();
      if (!botResponseText) {
        this.log("Keine Antwort vom Bot erhalten.");
        this.startConversationLoop();
        return;
      }

      this.conversation.push({ role: "assistant", content: botResponseText });
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

  async getBotResponse() {
    this.log(
      `Frage an OpenAI mit ${this.conversation.length} Nachrichten im Kontext...`
    );
    try {
      const response = await this.openai.chat.completions.create({
        model: this.cfg.model,
        messages: this.conversation,
      });
      const text = response.choices[0].message.content;
      this.log("Antwort erhalten:", text.trim());
      return text.trim();
    } catch (e) {
      this.error(`Fehler bei der Anfrage an die OpenAI API: ${e.message}`);
      return "Entschuldigung, ich habe gerade ein technisches Problem.";
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
      player.on("close", resolve);
      player.on("error", (err) => {
        this.error(`aplay Fehler: ${err.message}`);
        reject(err);
      });
      player.stdin.end(buffer);
    });
  },

  startConversationLoop() {
    this.log("Aktiviere Mikrofon für die nächste Runde...");
    this.sendNotification("HOTWORD_ACTIVATE", { asDetected: "COMPUTER" });
    this.startConversationTimeout();
  },

  startConversationTimeout() {
    this.stopConversationTimeout();
    this.log(
      `Konversation wird in ${
        this.cfg.silenceMs / 1000
      }s beendet, wenn nichts gesagt wird.`
    );
    this.conversationTimeout = setTimeout(() => {
      this.endConversation();
    }, this.cfg.silenceMs);
  },

  stopConversationTimeout() {
    if (this.conversationTimeout) clearTimeout(this.conversationTimeout);
    this.conversationTimeout = null;
  },

  endConversation() {
    this.log("Konversation beendet. Warte auf neues Weckwort.");
    this.sendNotification("HOTWORD_DEACTIVATE");
    this.conversation = [];
    this.send("CONVERSATION_END");
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
