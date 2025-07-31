// node_helper.js – volle Chat-/Responses-Streaming-Pipeline, robustes Logging
"use strict";

/**
 * MMM-OpenAIVoice · Node-Helper
 * ─────────────────────────────
 * 1. WAV von MMM-Hotword2 → STT  (gpt-4o-mini-transcribe)
 * 2. LLM-Antwort  • versucht Responses-API
 *                • Fallback Chat-Completions-Streaming
 * 3. TTS (wav oder pcm) → aplay
 * 4. Alle Events / Fehler gehen als Socket-Notify an Front-End
 */

const NodeHelper = require("node_helper");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");
require("dotenv").config();

const SENT_END = /[.!?]\s$/; // sehr simple Satzgrenze

module.exports = NodeHelper.create({
  init() {
    this.conv = []; // Kontextspeicher
    this.prevId = undefined; // für Responses-API
    this.lastTs = 0;
  },

  /* ----------- Socket-Brücke MM ⟷ Helper ----------- */
  socketNotificationReceived(type, payload) {
    if (type === "OPENAIVOICE_INIT") {
      this.cfg = payload;
      this.debug = !!this.cfg.debug;
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY || this.cfg.openAiKey,
      });
      this.log("Init – Modell:", this.cfg.model);
      return;
    }

    if (type === "OPENAIVOICE_AUDIO" && payload?.filePath) {
      this.handleAudio(payload.filePath).catch((err) => this.error(err));
    }
  },

  /* ---------------- Haupt-Pipeline ----------------- */
  async handleAudio(wavPath) {
    /* 1 STT */
    const userText = await this.stt(wavPath);
    this.send("USER", userText);
    this.conv.push({ role: "user", content: userText });

    /* 2 LLM-Antwort → Streaming-Text */
    const buffer = await this.llmStream(); // gibt kompletten Antwort-String zurück

    /* 3 TTS */
    await this.say(buffer.trim());

    /* 4 Kontext */
    this.lastTs = Date.now();
  },

  /* -------------- Speech-to-Text ------------------- */
  async stt(path) {
    const t0 = Date.now();
    const txt = await this.openai.audio.transcriptions.create({
      file: fs.createReadStream(path),
      model: "gpt-4o-mini-transcribe",
      response_format: "text",
    });
    this.log(`STT  ⏱ ${Date.now() - t0} ms →`, txt.trim());
    return txt.trim();
  },

  /* ------------ LLM-Streaming (Resp → Chat) -------- */
  async llmStream() {
    const model = this.cfg.model;
    let stream;
    let usingResponses = true;

    try {
      stream = await this.openai.responses.create({
        model,
        input: this.conv,
        previous_response_id: this.prevId ?? undefined,
        stream: true,
        store: false,
      });
      this.log("PIPE = Responses-API", model);
    } catch (e) {
      usingResponses = false;
      this.log(
        `Responses-API failed (${
          e.status || e.message
        }) –> fallback Chat-Completions`
      );
      stream = await this.openai.chat.completions.create({
        model,
        messages: this.conv,
        stream: true,
      });
    }

    /* Normalisieren des Streams */
    const it = usingResponses
      ? stream[Symbol.asyncIterator]() // Responses-Events liefern .content[0].text
      : stream[Symbol.asyncIterator](); // Chat-Stream liefert choices[0].delta.content

    let buf = "";
    for await (const chunk of it) {
      const delta = usingResponses
        ? chunk.content?.[0]?.text || ""
        : chunk.choices?.[0]?.delta?.content || "";

      if (!delta) continue; // leeren Chunk ignorieren
      buf += delta;
      this.log("CHUNK:", delta.replace(/\n/g, "↵"));
      if (SENT_END.test(buf)) {
        this.send("BOT", buf.trim()); // Text schon anzeigen
      }
    }

    this.prevId = usingResponses ? stream.id : undefined; // Responses speichert Thread-ID
    this.send("BOT", buf.trim()); // finale Sicherung
    return buf;
  },

  /* ---------------- Text-to-Speech ----------------- */
  async say(text) {
    const t0 = Date.now();
    const fmt = "wav"; // "pcm" → schneller, s. config-Tabelle
    const speech = await this.openai.audio.speech.create({
      model: this.cfg.ttsModel,
      voice: this.cfg.voice,
      input: text,
      response_format: fmt,
    });
    const audioBuf = Buffer.from(await speech.arrayBuffer());
    this.log(`TTS  ⏱ ${Date.now() - t0} ms · ${audioBuf.length} bytes`);

    await this.play(audioBuf, fmt);
  },

  play(buf, fmt) {
    return new Promise((res, rej) => {
      const args = [
        "-q",
        "-D",
        this.cfg.playbackDevice || "default",
        ...(fmt === "wav"
          ? ["-t", "wav"]
          : ["-t", "raw", "-f", "S16_LE", "-r", "24000", "-c", "1"]),
      ];
      const p = spawn("aplay", args);
      p.on("close", res).on("error", rej);
      p.stdin.end(buf);
    });
  },

  /* ------------------- Utils ----------------------- */
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
