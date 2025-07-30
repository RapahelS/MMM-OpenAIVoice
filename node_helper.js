/**
 * Node-Helper für MMM-OpenAIVoice
 *  – Wake-Word via Porcupine
 *  – Aufnahme via node-record-lpcm16
 *  – OpenAI STT / Chat / TTS
 *  – Wiedergabe via aplay
 */
"use strict";
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const record = require("node-record-lpcm16");
const { spawn } = require("child_process");
const { Porcupine } = require("@picovoice/porcupine-node");
require("dotenv").config();
const OpenAI = require("openai");

module.exports = NodeHelper.create({
  porcupine: null,
  busy: false,
  openai: null,

  socketNotificationReceived(notification, cfg) {
    if (notification !== "OPENAIVOICE_INIT") return;
    this.cfg = cfg;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || cfg.openAiKey,
    });
    this.initWakeWord();
  },

  /**
   * Wake-Word-Engine initialisieren.
   */
  initWakeWord() {
    const accessKey =
      process.env.PORCUPINE_ACCESS_KEY || this.cfg.porcupineAccessKey;

    // absoluter Pfad zur .ppn-Datei
    const kwPath = path.isAbsolute(this.cfg.wakeWord)
      ? this.cfg.wakeWord
      : path.join(process.cwd(), this.cfg.wakeWord);

    // Porcupine erwartet: (accessKey, [keywordPaths], callback)
    this.porcupine = new Porcupine(
      accessKey,
      [kwPath],
      () => this.startRecording() // Callback bei Erkennung
    );

    // Mikrofon-Stream → Porcupine
    record
      .start({
        sampleRateHertz: 16000,
        threshold: 0,
        recordProgram: this.cfg.recordProgram,
        device: this.cfg.alsaDevice || undefined,
      })
      .pipe(this.porcupine);
  },

  /**
   * Audioaufnahme starten.
   */
  startRecording() {
    if (this.busy) return;
    this.busy = true;
    const file = path.join(__dirname, "temp.wav");

    const rec = record.start({
      endOnSilence: true,
      silence: "1.0",
      sampleRateHertz: 16000,
      threshold: 0,
      recordProgram: this.cfg.recordProgram,
      device: this.cfg.alsaDevice || undefined,
    });
    const ws = fs.createWriteStream(file);
    rec.pipe(ws);

    const stop = () => {
      record.stop();
      ws.close();
      this.handleAudio(file).finally(() => {
        fs.unlink(file, () => {});
        setTimeout(() => (this.busy = false), 300);
      });
    };
    setTimeout(stop, this.cfg.maxRecordSeconds * 1000);
    rec.on("end", stop);
  },

  /**
   * STT → Chat → TTS → Wiedergabe + UI-Update
   */
  async handleAudio(file) {
    try {
      // 1 STT
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: this.cfg.transcribeModel,
        response_format: "text",
      });
      this.sendSocketNotification("OPENAIVOICE_TRANSCRIPTION", transcription);

      // 2 Chat
      const completion = await this.openai.chat.completions.create({
        model: this.cfg.openAiModel,
        messages: [
          {
            role: "system",
            content: "Du bist ein hilfreicher Spiegel-Assistent.",
          },
          { role: "user", content: transcription },
        ],
      });
      const answer = completion.choices[0].message.content;

      // 3 TTS
      const speech = await this.openai.audio.speech.create({
        model: this.cfg.ttsModel,
        voice: this.cfg.voice,
        input: answer,
        format: "wav",
      });
      const audioBuf = Buffer.from(await speech.arrayBuffer());

      await this.playAudio(audioBuf);

      // 4 Frontend-Update
      this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
    } catch (err) {
      this.sendSocketNotification("OPENAIVOICE_ERROR", err.message);
      console.error("[MMM-OpenAIVoice]", err);
    }
  },

  /**
   * Wiedergabe via ALSA-aplay.
   */
  playAudio(buffer) {
    return new Promise((resolve, reject) => {
      const dev = this.cfg.playbackDevice || "default";
      const p = spawn("aplay", ["-q", "-D", dev, "-t", "wav", "-"]);
      p.on("close", resolve);
      p.on("error", reject);
      p.stdin.write(buffer);
      p.stdin.end();
    });
  },
});
