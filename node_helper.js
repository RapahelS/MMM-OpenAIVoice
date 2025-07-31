"use strict";
const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");
require("dotenv").config();

const SENT_END = /[.!?]\s$/;

module.exports = NodeHelper.create({
  init() {
    this.conv = [];
    this.lastTs = 0;
  },

  /* --------------------- Nachrichten --------------------- */
  socketNotificationReceived(type, payload) {
    if (type === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      this.debug = Boolean(this.cfg.debug);
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || this.cfg.openAiKey,
      });
      return;
    }
    if (type === "OPENAIVOICE_AUDIO")
      this.handleAudio(payload.filePath).catch((err) => this.error(err));
  },

  /* ----------------------- Pipeline ---------------------- */
  async handleAudio(wavPath) {
    try {
      const transcript = await this.stt(wavPath);
      this.send("USER", transcript);
      this.conv.push({ role: "user", content: transcript });

      const stream = await this.openai.responses.create({
        model: this.cfg.model, // ✅ jetzt vorhanden
        input: this.conv,
        previous_response_id: this.prevId ?? undefined,
        stream: true,
        store: false,
      });

      let buf = "";
      for await (const evt of stream) {
        if (evt.type !== "message") continue;
        const delta = evt.content[0].text;
        buf += delta;
        if (SENT_END.test(buf)) {
          await this.say(buf.trim());
          buf = "";
        }
        this.prevId = evt.id;
      }
      if (buf) await this.say(buf.trim());
    } catch (err) {
      this.error(err);
    }
  },

  /* -------------------- Hilfsfunktionen ------------------ */
  async stt(path) {
    const t0 = Date.now();
    const text = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(path),
      model: "gpt-4o-mini-transcribe",
      response_format: "text",
    });
    this.log("STT  ⏱", Date.now() - t0, "ms:", text.trim());
    return text.trim();
  },

  async say(text) {
    this.conv.push({ role: "assistant", content: text });
    this.send("BOT", text);

    const t0 = Date.now();
    const speech = await this.openai.audio.speech.create({
      model: this.cfg.ttsModel,
      voice: this.cfg.voice,
      input: text,
      response_format: "wav", // ALTERNATIV: "pcm" für -20 % Latenz
    });
    const wav = Buffer.from(await speech.arrayBuffer());
    this.log("TTS  ⏱", Date.now() - t0, "ms · bytes", wav.length);

    await this.play(wav);
  },

  play(buf) {
    return new Promise((res, rej) => {
      const args = [
        "-q",
        "-D",
        this.cfg.playbackDevice || "default",
        "-f",
        "S16_LE",
        "-c",
        "1",
        "-r",
        "24000",
        "-t",
        "wav", // bei "pcm" hier "raw"
      ];
      const p = spawn("aplay", args);
      p.on("close", res).on("error", rej);
      p.stdin.end(buf);
    });
  },

  /* ----------------------- Utils ------------------------- */
  send(tag, txt) {
    this.sendSocketNotification(`OPENAIVOICE_${tag}`, txt);
  },
  log(...a) {
    if (this.debug) console.log("[OpenAIVoice]", ...a);
  },
  error(e) {
    console.error(e);
    this.send("ERR", e.message);
  },
});
