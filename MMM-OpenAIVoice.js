/* eslint-env browser */
/**
 * MMM-OpenAIVoice - Frontend (Final, Robust)
 * - Zeigt die Konversation auf dem Bildschirm an.
 */
Module.register("MMM-OpenAIVoice", {
  defaults: {
    openAiKey: "",
    model: "gpt-4o-mini",
    ttsModel: "gpt-4o-mini-tts",
    transcribeModel: "gpt-4o-mini-transcribe",
    voice: "alloy",
    playbackDevice: "default",
    silenceMs: 15000,
    debug: false,
  },

  getStyles: () => ["MMM-OpenAIVoice.css"],

  start() {
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
      case "OPENAIVOICE_USER_TRANSCRIPTION":
        // Bei der ersten Nutzer-Eingabe nach dem Weckwort, die UI leeren.
        if (!this.conversationStarted) {
          chatContainer.innerHTML = "";
          this.conversationStarted = true;
        }
        this.addMessage("👤", payload);
        break;
      case "OPENAIVOICE_BOT_CHUNK": // Empfängt jetzt die ganze Nachricht
        this.addMessage("🤖", payload);
        break;
      case "OPENAIVOICE_CONVERSATION_END":
        this.conversationStarted = false;
        // Optional eine Nachricht anzeigen, dass die Konversation beendet ist.
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
    chatContainer.scrollTop = chatContainer.scrollHeight; // Auto-scroll
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
