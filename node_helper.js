/**
 * Node-Helper für MMM-OpenAIVoice  –  Version mit aplay & korrektem Porcupine-Aufruf
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

  initWakeWord() {
    const accessKey =
      process.env.PORCUPINE_ACCESS_KEY || this.cfg.porcupineAccessKey;
    const kwPath = path.isAbsolute(this.cfg.wakeWord)
      ? this.cfg.wakeWord
      : path.join(process.cwd(), this.cfg.wakeWord);

    const keywordPaths = [kwPath];
    const sensitivities = [0.5]; // 0 → unempfindlich, 1 → sehr empfindlich

    this.porcupine = new Porcupine(
      accessKey,
      keywordPaths,
      sensitivities,
      () => this.startRecording() // Callback bei Erkennung
    );

    record
      .start({
        sampleRateHertz: 16000,
        threshold: 0,
        recordProgram: this.cfg.recordProgram,
        device: this.cfg.alsaDevice || undefined,
      })
      .pipe(this.porcupine);
  },

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
    rec.pipe(fs.createWriteStream(file));

    const stop = () => {
      record.stop();
      this.handleAudio(file)
        .catch((err) => console.error("[MMM-OpenAIVoice]", err))
        .finally(() => {
          fs.unlink(file, () => {});
          setTimeout(() => (this.busy = false), 300);
        });
    };
    setTimeout(stop, this.cfg.maxRecordSeconds * 1000);
    rec.on("end", stop);
  },

  async handleAudio(file) {
    // 1  Transkription
    const transcription = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(file),
      model: this.cfg.transcribeModel,
      response_format: "text",
    });
    this.sendSocketNotification("OPENAIVOICE_TRANSCRIPTION", transcription);

    // 2  Chat
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

    // 3  TTS
    const speech = await this.openai.audio.speech.create({
      model: this.cfg.ttsModel,
      voice: this.cfg.voice,
      input: answer,
      format: "wav",
    });
    const audioBuf = Buffer.from(await speech.arrayBuffer());
    await this.playAudio(audioBuf);

    // 4  UI-Update
    this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
  },

  /** Wiedergabe via aplay */
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
