"use strict";
/**
 * Node-Helper für MMM-OpenAIVoice.
 * Wake-Word, Aufnahme, STT→LLM→TTS-Pipeline.
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
  porcupine: null,
  busy: false,
  openai: null,

  // -------------------------------------------------- Init aus Front-End
  socketNotificationReceived(notification, cfg) {
    if (notification !== "OPENAIVOICE_INIT") return;
    this.cfg = cfg;
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || cfg.openAiKey,
    });
    this.initWakeWord();
  },

  // -------------------------------------------------- Wake-Word-Initialisierung
  initWakeWord() {
    const accessKey =
      process.env.PORCUPINE_ACCESS_KEY || this.cfg.porcupineAccessKey;

    /*
     * Pfad-Auflösung:
     *   – absoluter Pfad bleibt unverändert
     *   – sonst relativ zum MagicMirror-Haupt­verzeichnis (process.cwd())
     *     → vermeidet Dopplungen wie “…MMM-OpenAIVoice/modules/MMM-OpenAIVoice/…”
     */
    const kwPath = path.isAbsolute(this.cfg.wakeWord)
      ? this.cfg.wakeWord
      : path.resolve(process.cwd(), this.cfg.wakeWord);

    if (!fs.existsSync(kwPath)) {
      this.sendSocketNotification(
        "OPENAIVOICE_ERROR",
        `Wake-Word-Datei nicht gefunden: ${kwPath}`
      );
      return; // früh abbrechen, sonst crasht Porcupine
    }

    const modelPath = path.resolve(__dirname, "models/porcupine_params_de.pv");

    if (!fs.existsSync(modelPath))
      throw new Error(`Modelldatei fehlt: ${modelPath}`);

    // Porcupine – Parameter­folge laut Node-API :contentReference[oaicite:0]{index=0}
    this.porcupine = new Porcupine(
      accessKey,
      [kwPath],
      [0.5], // Sensitivität
      modelPath
    );

    /* Transform-Stream leitet PCM-Frames an Porcupine */
    const porcupineStream = new Transform({
      readableObjectMode: true,
      transform: (chunk, _enc, cb) => {
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
      .pipe(porcupineStream);
  },

  // -------------------------------------------------- Aufnahme
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

  // -------------------------------------------------- STT → LLM → TTS
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
        model: "whisper-1", // Fallback
      });
    }
    this.sendSocketNotification("OPENAIVOICE_TRANSCRIPTION", transcript);

    // --- Chat-Completion
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
        model: "tts-1", // Fallback
        voice: this.cfg.voice,
        input: answer,
        format: "wav",
      });
    }

    await this.playAudio(Buffer.from(await speech.arrayBuffer()));
    this.sendSocketNotification("OPENAIVOICE_RESPONSE", answer);
  },

  // -------------------------------------------------- Wiedergabe
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
