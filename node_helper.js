"use strict";
/**
 * Node-Helper für MMM-OpenAIVoice.
 * Enthält Wake-Word-Erkennung (Porcupine), Aufzeichnung (arecord),
 * STT → LLM → TTS Pipeline (OpenAI).
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const record = require("node-record-lpcm16");
const { Transform } = require("stream");
const { Porcupine } = require("@picovoice/porcupine-node");
require("dotenv").config();
const OpenAI = require("openai");

module.exports = NodeHelper.create({
  /** @type {Porcupine|null} */
  porcupine: null,
  busy: false,
  openai: null,

  /** Entry-Point – kommt aus Frontend. */
  socketNotificationReceived(notification, cfg) {
    if (notification !== "OPENAIVOICE_INIT") return;
    this.cfg = cfg;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || cfg.openAiKey,
    });
    this.initWakeWord();
  },

  /** Initialisiert Wake-Word-Engine. */
  initWakeWord() {
    const accessKey =
      process.env.PORCUPINE_ACCESS_KEY || this.cfg.porcupineAccessKey;

    // Absoluter Pfad, damit Porcupine ihn sicher findet
    const kwPath = path.isAbsolute(this.cfg.wakeWord)
      ? this.cfg.wakeWord
      : path.join(__dirname, this.cfg.wakeWord);

    // Reihenfolge: accessKey, keywordPaths, sensitivities, modelPath?
    this.porcupine = new Porcupine(
      accessKey,
      [kwPath],
      [0.5],
      null // deutsches Standard-Raspberry-Model
    ); // :contentReference[oaicite:3]{index=3}

    // Transform-Stream, der 16-bit-PCM-Frames weiterleitet.
    const porcupineStream = new Transform({
      readableObjectMode: true,
      transform: (chunk, _enc, cb) => {
        // chunk = <Buffer ...> ; Länge == frameLength*2
        const keywordIndex = this.porcupine.process(chunk);
        if (keywordIndex >= 0) this.startRecording();
        cb(null, chunk);
      },
    });

    record
      .start({
        sampleRateHertz: 16000,
        threshold: 0,
        recordProgram: this.cfg.recordProgram,
        device: this.cfg.alsaDevice ?? undefined,
      })
      .pipe(porcupineStream); // kein .pipe(this.porcupine) mehr
  },

  /** Startet Benutzer-Aufnahme nach Wake-Word. */
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
      device: this.cfg.alsaDevice ?? undefined,
    });

    rec.pipe(fs.createWriteStream(file));

    const finalize = () => {
      record.stop();
      this.handleAudio(file)
        .catch((err) =>
          this.sendSocketNotification("OPENAIVOICE_ERROR", String(err))
        )
        .finally(() => {
          fs.unlink(file, () => {});
          setTimeout(() => (this.busy = false), 500);
        });
    };

    setTimeout(finalize, this.cfg.maxRecordSeconds * 1000);
    rec.once("end", finalize);
  },

  /** Führt STT → LLM → TTS Pipeline aus. */
  async handleAudio(file) {
    // ---------- Speech-to-Text ----------
    let transcript;
    try {
      transcript = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: this.cfg.transcribeModel,
        response_format: "text",
      });
    } catch {
      // proprietäres Modell evtl. nicht freigeschaltet → Whisper-Fallback
      transcript = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(file),
        model: "whisper-1", // :contentReference[oaicite:4]{index=4}
      });
    }
    this.sendSocketNotification("OPENAIVOICE_TRANSCRIPTION", transcript);

    // ---------- Chat-Completion ----------
    const completion = await this.openai.chat.completions.create({
      model: this.cfg.openAiModel,
      messages: [
        {
          role: "system",
          content: "Du bist ein hilfreicher Spiegel-Assistent.",
        },
        { role: "user", content: transcript },
      ],
    });
    const answer = completion.choices[0].message.content;

    // ---------- Text-to-Speech ----------
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
        model: "tts-1", // :contentReference[oaicite:5]{index=5}
        voice: this.cfg.voice,
        input: answer,
        format: "wav",
      });
    }

    await this.playAudio(Buffer.from(await speech.arrayBuffer()));
    this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
  },

  /** Spielt WAV-Buffer über ALSA-Device ab. */
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
