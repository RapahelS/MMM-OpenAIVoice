/* eslint-env browser */
/**
 * MMM-OpenAIVoice - Frontend (Final, Architecturally Correct)
 * - Zeigt die Konversation an.
 * - Steuert das MMM-Hotword2-Modul auf Anweisung seines Node Helpers.
 */
Module.register("MMM-OpenAIVoice", {
  defaults: {
    openAiKey: "",
    model: "gpt-4.1-mini",
    ttsModel: "gpt-4o-mini-tts",
    transcribeModel: "gpt-4o-mini-transcribe",
    voice: "alloy",
    playbackDevice: "default",
    silenceMs: 15000,
    debug: false,
  },

  getStyles: () => ["MMM-OpenAIVoice.css"],

  start() {
    this.conversationStarted = false;
    this.sendSocketNotification("OPENAIVOICE_INIT", this.config);
    this.updateDom(0);
  },

  notificationReceived(notification, payload) {
    if (notification === "OPENAIVOICE_AUDIO") {
      this.sendSocketNotification("OPENAIVOICE_PROCESS_AUDIO", payload);
    }
    if (notification === "OPENAIVOICE_ERROR") {
      this.socketNotificationReceived("OPENAIVOICE_ERROR", payload);
    }
  },

  socketNotificationReceived(notification, payload) {
    const chatContainer = document.getElementById("openaivoice-chat");
    if (!chatContainer) return;

    switch (notification) {
      // FIX: Fängt die Steuerbefehle vom Helper ab und leitet sie korrekt weiter.
      case "HOTWORD_CONTROL":
        console.log(
          `[MMM-OpenAIVoice] Received HOTWORD_CONTROL: ${payload.action}`
        );
        if (payload.action === "ACTIVATE") {
          this.sendNotification("HOTWORD_ACTIVATE", { asDetected: "COMPUTER" });
        } else if (payload.action === "DEACTIVATE") {
          this.sendNotification("HOTWORD_DEACTIVATE");
        }
        break;

      case "OPENAIVOICE_USER_TRANSCRIPTION":
        if (!this.conversationStarted) {
          chatContainer.innerHTML = "";
          this.conversationStarted = true;
        }
        this.addMessage("👤", payload);
        break;
      case "OPENAIVOICE_BOT_CHUNK":
        this.addMessage("🤖", payload);
        break;
      case "OPENAIVOICE_CONVERSATION_END":
        this.conversationStarted = false;
        chatContainer.innerHTML = "Sag „Computer…“";
        break;
      case "OPENAIVOICE_ERROR":
        this.addMessage("⚠️", payload);
        break;
    }
  },

  addMessage(tag, text) {
    const chatContainer = document.getElementById("openaivoice-chat");
    if (!chatContainer) return;
    const messageElement = document.createElement("div");
    messageElement.innerHTML = `<strong>${tag}</strong> ${text.replace(
      /\n/g,
      "<br>"
    )}`;
    chatContainer.appendChild(messageElement);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "MMM-OpenAIVoice";
    const chatContainer = document.createElement("div");
    chatContainer.id = "openaivoice-chat";
    chatContainer.innerHTML = "Sag „Computer…“";
    wrapper.appendChild(chatContainer);
    return wrapper;
  },
});
