"use strict";
/**
 * Node-Helper: STT → LLM → TTS.
 * Erwartet WAV-Pfad aus MMM-Hotword2.
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");
require("dotenv").config();

module.exports = NodeHelper.create({
  busy: false,
  openai: null,
  cfg: {},

  /** Init von Front-End. */
  socketNotificationReceived(notification, payload) {
    if (notification === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      /* Umgebungsvariable schlägt Konfig-Key. */
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || this.cfg.openAiKey,
      });
      return;
    }

    if (notification === "OPENAIVOICE_AUDIO" && payload?.filePath) {
      if (this.busy) {
        this.sendSocketNotification(
          "OPENAIVOICE_ERROR",
          "Assistent beschäftigt – bitte kurz warten."
        );
        return;
      }
      this.busy = true;
      this.handleAudio(payload.filePath)
        .catch((err) =>
          this.sendSocketNotification("OPENAIVOICE_ERROR", String(err))
        )
        .finally(() => (this.busy = false));
    }
  },

  // ---------- Haupt-Pipeline ----------
  async handleAudio(file) {
    // --- Speech-to-Text
    let transcript;
    try {
      transcript = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: this.cfg.transcribeModel,
        response_format: "text",
      });
    } catch {
      transcript = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: "whisper-1",
      });
    }
    this.sendSocketNotification("OPENAIVOICE_TRANSCRIPTION", transcript);

    // --- Chat-Completion
    const completion = await this.openai.chat.completions.create({
      model: this.cfg.openAiModel,
      messages: [
        {
          role: "system",
          content:
            "Du bist ein hilfreich-knapper Spiegel-Assistent und antwortest in natürlichem Deutsch.",
        },
        { role: "user", content: transcript },
      ],
    });
    const answer = completion.choices[0].message.content;

    // --- Text-to-Speech
    let speech;
    try {
      speech = await this.openai.audio.speech.create({
        model: this.cfg.ttsModel,
        voice: this.cfg.voice,
        input: answer,
        format: "wav",
      });
    } catch {
      speech = await this.openai.audio.speech.create({
        model: "tts-1",
        voice: this.cfg.voice,
        input: answer,
        format: "wav",
      });
    }

    await this.playAudio(Buffer.from(await speech.arrayBuffer()));
    this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
  },

  // ---------- Wiedergabe ----------
  playAudio(buffer) {
    return new Promise((resolve, reject) => {
      const dev = this.cfg.playbackDevice || "default";
      const p = spawn("aplay", ["-q", "-D", dev, "-t", "wav", "-"]);
      p.on("close", resolve);
      p.on("error", reject);
      p.stdin.end(buffer);
    });
  },
});
