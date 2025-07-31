"use strict";
/** Node-Helper: WAV-→ STT → Responses-Streaming → TTS-Streaming → Playback. */

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");
require("dotenv").config();

const SENT_END = /[.!?]\s$/; // einfacher Satztrenner

module.exports = NodeHelper.create({
  init() {
    this.conv = [];
    this.lastTs = 0;
  },

  socketNotificationReceived(type, payload) {
    if (type === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || this.cfg.openAiKey,
      });
      return;
    }
    if (type === "OPENAIVOICE_AUDIO")
      this.handleAudio(payload.filePath).catch((e) => this.error(e));
  },

  /* ---------- Pipeline ---------- */
  async handleAudio(wavPath) {
    /* 1 STT */
    const transcript = await this.stt(wavPath);
    this.send("USER", transcript);
    this.conv.push({ role: "user", content: transcript });

    /* 2 Responses-Streaming */
    const textStream = await this.openai.responses.create({
      model: this.cfg.model,
      input: this.conv,
      previous_response_id: this.prevId ?? undefined,
      stream: true,
      store: false,
    });

    /* Sammeln + Parallel-TTS */
    let buffer = "";
    for await (const evt of textStream) {
      if (evt.type !== "message") continue;
      const delta = evt.content[0].text;
      buffer += delta;
      if (SENT_END.test(buffer)) {
        await this.say(buffer.trim());
        buffer = "";
      }
      this.prevId = evt.id; // für Multiturn-Kontext
    }
    if (buffer) await this.say(buffer.trim());
    this.lastTs = Date.now();
  },

  /* ---------- Einzel-Bausteine ---------- */
  async stt(path) {
    const res = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(path),
      model: "gpt-4o-mini-transcribe",
      response_format: "text",
    });
    return res.trim();
  },

  async say(text) {
    /* push in Konversation */
    this.conv.push({ role: "assistant", content: text });

    /* TTS – 24 kHz PCM */
    const speech = await this.openai.audio.speech.create({
      model: this.cfg.ttsModel,
      voice: this.cfg.voice,
      input: text,
      response_format: "wav",
    });
    const wav = Buffer.from(await speech.arrayBuffer());

    /* asynchron abspielen, GUI-Text sofort schicken */
    this.send("BOT", text);
    await this.play(wav);
  },

  play(buf) {
    return new Promise((res, rej) => {
      const dev = this.cfg.playbackDevice;
      const p = spawn(
        "aplay",
        ["-q", "-D", dev, "-f", "S16_LE", "-c", "1", "-r", "24000", "-"],
        { stdio: ["pipe", "ignore", "ignore"] }
      );
      p.on("close", res).on("error", rej);
      p.stdin.end(buf);
    });
  },

  send(tag, txt) {
    this.sendSocketNotification(`OPENAIVOICE_${tag}`, txt);
  },
  error(e) {
    this.send("ERR", e.message);
    console.error(e);
  },
});
