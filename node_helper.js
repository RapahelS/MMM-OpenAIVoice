/**
 * Node-Helper für MMM-OpenAIVoice.
 * Verantwortlich für Wake-Word-Erkennung, Recording,
 * OpenAI-Aufrufe (STT, Chat, TTS) und Audiowiedergabe.
 */
"use strict";
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const record = require("node-record-lpcm16");
const Speaker = require("speaker");
const { Porcupine } = require("@picovoice/porcupine-node");
require("dotenv").config();
const OpenAI = require("openai");

module.exports = NodeHelper.create({
  /** @type {ReturnType<Porcupine['process']>|null} */
  porcupine: null,
  /** @type {boolean} */
  busy: false, // Debounce-Flag
  /** @type {OpenAI|null} */
  openai: null,

  /**
   * Empfängt Initial-Konfiguration vom Frontend.
   */
  async socketNotificationReceived(notification, cfg) {
    if (notification !== "OPENAIVOICE_INIT") return;
    this.cfg = cfg;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || cfg.openAiKey,
    });
    this.initWakeWord();
  },

  /**
   * Wake-Word-Engine starten.
   */
  initWakeWord() {
    this.porcupine = new Porcupine(
      {
        accessKey:
          process.env.PORCUPINE_ACCESS_KEY || this.cfg.porcupineAccessKey,
        keywordPath: this.cfg.wakeWord,
      },
      /* onDetection */ () => this.startRecording()
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

  /**
   * Aufnahme starten (Raw PCM ➜ WAV-Datei).
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
    const ws = fs.createWriteStream(file, { encoding: "binary" });
    rec.pipe(ws);

    const stop = () => {
      record.stop();
      ws.close();
      this.handleAudio(file).finally(() => {
        fs.unlink(file, () => {});
        setTimeout(() => (this.busy = false), 300); // Cooldown
      });
    };
    setTimeout(stop, this.cfg.maxRecordSeconds * 1000);
    rec.on("end", stop);
  },

  /**
   * Audiofile ➜ STT ➜ Chat ➜ TTS ➜ Playback.
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

      // Samplerate aus Header lesen, fallback 24000 Hz
      const sr = speech.headers.get("x-audio-sample-rate") || 24000;
      await this.playAudio(audioBuf, Number(sr));

      // 4 UI-Update
      this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
    } catch (err) {
      this.sendSocketNotification("OPENAIVOICE_ERROR", err.message);
      console.error("[MMM-OpenAIVoice]", err);
    }
  },

  /**
   * Audio-Buffer auf ALSA ausgeben.
   * @param {Buffer} buffer
   * @param {number} sampleRate
   */
  playAudio(buffer, sampleRate) {
    return new Promise((res) => {
      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate,
        device: this.cfg.playbackDevice || "default",
      });
      speaker.on("close", res);
      speaker.end(buffer);
    });
  },
});
