// node_helper.js – Finale, stabile Version mit Konversations-Loop und Web-Suche
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
    // Die Responses API verwaltet den Kontext über eine ID, nicht über das Array.
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

      // Wir nutzen jetzt die Responses API für intelligente Tool-Nutzung (Web-Suche)
      const botResponseText = await this.getBotResponseWithTools(userText);
      if (!botResponseText) {
        this.log("Keine Antwort vom Bot erhalten.");
        this.startConversationLoop();
        return;
      }

      // Senden der kompletten Antwort an die UI
      this.send("BOT_CHUNK", botResponseText);

      await this.playTextAsSpeech(botResponseText);

      // Nach der Antwort des Bots, sofort wieder auf eine Nutzereingabe lauschen
      this.startConversationLoop();
    } catch (err) {
      this.error(err.message || "Unbekannter Fehler in der Pipeline.");
      this.endConversation(); // Bei Fehler Konversation sicher beenden
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

  // Umbenannt und umgestellt auf die RESPONSES API mit Web-Suche
  async getBotResponseWithTools(userText) {
    this.log("Frage an Responses API mit Web-Suche...");
    try {
      const response = await this.openai.responses.create({
        model: this.cfg.model, // z.B. gpt-4.1-mini oder gpt-4o-mini
        input: userText,
        // Konversationsverlauf wird über diese ID gesteuert
        previous_response_id: this.previousResponseId,
        // Das Modell entscheidet selbst, ob es das Tool braucht
        tools: [{ type: "web_search" }],
        stream: false, // Wichtig: Kein Streaming für mehr Stabilität
      });

      // Die neue ID für die nächste Runde speichern
      this.previousResponseId = response.id;
      const text = response.content[0].text;

      this.log("Antwort von Responses API erhalten:", text.trim());
      return text.trim();
    } catch (e) {
      this.error(`Fehler bei der Anfrage an die Responses API: ${e.message}`);
      // Bei Fehler die Konversation zurücksetzen, um Folgefehler zu vermeiden
      this.previousResponseId = null;
      return "Entschuldigung, ich habe gerade ein Problem mit meinen Werkzeugen.";
    }
  },

  async playTextAsSpeech(text) {
    /* ... bleibt unverändert aus der letzten Version ... */
  },
  playAudioBuffer(buffer) {
    /* ... bleibt unverändert aus der letzten Version ... */
  },

  // Konversations-Loop Logik
  startConversationLoop() {
    this.log("Aktiviere Mikrofon für die nächste Runde...");
    // Hier ist this.sendNotification korrekt, da es direkt in der Klasse aufgerufen wird
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
    // FIX: Eine Arrow-Function `() => {}` verwenden, um den 'this'-Kontext zu erhalten.
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
    // Hier war der Fehler: this.sendNotification ist jetzt im korrekten Kontext
    this.sendNotification("HOTWORD_DEACTIVATE");
    // Konversationsverlauf für die API zurücksetzen
    this.previousResponseId = null;
    this.send("CONVERSATION_END");
  },

  // Utils
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
