document.addEventListener("DOMContentLoaded", async () => {
  let initialized = false;
  if (initialized) return;
  initialized = true;

  const statusIndicator = document.getElementById("statusIndicator");
  const startButton = document.getElementById("startButton");
  const stopButton = document.getElementById("stopButton");
  const actionButtonsGroup = document.querySelector(".action-buttons-group");
  const askButton = document.getElementById("askButton");
  const extendButton = document.getElementById("extendButton");
  const aiResponseArea = document.getElementById("aiResponseArea");
  const aiResponseContainer = document.getElementById("aiResponseContainer");

  let BASE_URL = "";

  let appStatus = "Ready";
  let currentConversationHistory = [];
  let mediaRecorder;
  let audioChunks = [];
  let cancelledRecording = false;

  async function initializeServerUrl() {
    try {
      const port = await window.electronAPI.getServerPort();
      if (port) {
        BASE_URL = `http://localhost:${port}`;
      } else {
        displayError("Failed to connect to backend server. Port not received.");
      }
    } catch (error) {
      displayError("Error initializing connection with backend server.");
    }
  }

  await initializeServerUrl();
  // add a delay to allow the backend server to be fully ready
  await new Promise(resolve => setTimeout(resolve, 1000));
  loadApiKeys();

  function loadApiKeys() {
    const geminiKey = localStorage.getItem("GEMINI_API_KEY") || "";
    const groqKey = localStorage.getItem("GROQ_API_KEY") || "";
    if (geminiKey && groqKey) {
      fetch(`${BASE_URL}/update-api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiKey, groqKey })
      })
      .then(response => {
         if (!response.ok) {
           console.error("Failed to update API keys on server.");
         } else {
           console.log("API keys loaded from localStorage and updated on server.");
         }
      })
      .catch(error => console.error("Error updating API keys on server:", error));
    }
  }

  window.electronAPI.onServerPort((port) => {
    if (port) {  // modified to always update BASE_URL when a port is received
      BASE_URL = `http://localhost:${port}`;
    }
  });

  function updateUIState(newStatus) {
    appStatus = newStatus;
    switch (appStatus) {
      case "Ready":
        statusIndicator.innerHTML =
          '<i class="fas fa-power-off"></i> Ready to Listen';
        startButton.disabled = false;
        startButton.style.display = "flex";
        actionButtonsGroup.style.display = "none";
        askButton.disabled = false;
        extendButton.disabled = currentConversationHistory.length === 0;
        stopButton.disabled = true;
        break;
      case "Listening":
        statusIndicator.innerHTML =
          '<i class="fas fa-microphone-alt"></i> Listening...';
        startButton.disabled = true;
        startButton.style.display = "none";
        actionButtonsGroup.style.display = "flex";
        askButton.disabled = false;
        extendButton.disabled = currentConversationHistory.length === 0;
        stopButton.disabled = false;
        break;
      case "Processing":
        statusIndicator.innerHTML =
          '<i class="fas fa-spinner fa-spin"></i> Processing...';
        startButton.disabled = true;
        actionButtonsGroup.style.display = "flex";
        askButton.disabled = true;
        extendButton.disabled = true;
        stopButton.disabled = true;
        break;
    }
  }

  function sanitizeHTML(html) {
    const temp = document.createElement("div");
    temp.innerHTML = html;
    temp
      .querySelectorAll("script,style,iframe,object,embed")
      .forEach((e) => e.remove());
    temp.querySelectorAll("*").forEach((el) => {
      [...el.attributes].forEach((attr) => {
        if (
          attr.name.startsWith("on") ||
          (attr.name === "src" && !attr.value.startsWith("data:")) ||
          (attr.name === "href" && !attr.value.startsWith("#"))
        )
          el.removeAttribute(attr.name);
      });
    });
    return temp.innerHTML;
  }

  function displayMessage(text, type = "normal") {
    let element;
    if (type === "laugh") {
      element = document.createElement("div");
      element.className = "laugh-message";
      const previousLaugh = aiResponseArea.querySelector(
        ".laugh-message:last-of-type"
      );
      if (previousLaugh) {
        previousLaugh.style.borderBottom = "1px solid #2A2A2A";
        previousLaugh.style.paddingBottom = "8px";
        previousLaugh.style.marginBottom = "8px";
      }
      element.innerHTML = sanitizeHTML(marked.parse(text));
    } else {
      element = document.createElement("span");
      if (type === "user") {
        element.className = "user-message";
        element.textContent = "YOU: " + text + "\n\n";
      } else if (type === "error") {
        element.className = "error-message";
        element.textContent = "Error: " + text + "\n\n";
      } else {
        element.className = "system-message";
        element.textContent = text;
      }
    }
    aiResponseArea.appendChild(element);
    scrollToBottom();
    return element;
  }

  function displayError(message) {
    displayMessage(message, "error");
    updateUIState(
      currentConversationHistory.length > 0 ? "Listening" : "Ready"
    );
  }

  async function setupAudioRecorder() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        if (cancelledRecording) {
          cancelledRecording = false;
          return;
        }
        if (!BASE_URL) {
          displayError("Backend server URL not configured. Cannot send audio.");
          updateUIState("Listening");
          return;
        }
        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        audioChunks = [];

        if (audioBlob.size === 0) {
          if (appStatus === "Processing") {
            displayMessage(
              "(No audio detected for the request. Please try again.)\n\n",
              "laugh"
            );
          }
          updateUIState("Listening");
          if (appStatus !== "Ready" && mediaRecorder?.state === "inactive")
            mediaRecorder.start();
          return;
        }

        const formData = new FormData();
        formData.append("audio", audioBlob, "recording.webm");

        statusIndicator.innerHTML =
          '<i class="fas fa-cog fa-spin"></i> Transcribing...';

        try {
          const response = await fetch(`${BASE_URL}/transcribe`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            const errorData = await response
              .json()
              .catch(() => ({ detail: "Unknown transcription error" }));
            throw new Error(
              errorData.detail ||
                `Transcription failed with status: ${response.status}`
            );
          }

          const data = await response.json();
          const transcript = data.transcript.trim();

          if (!transcript) {
            displayMessage(
              "(Couldn't hear anything clearly, please try again.)\n\n",
              "laugh"
            );
            updateUIState("Listening");
            if (appStatus !== "Ready" && mediaRecorder?.state === "inactive")
              mediaRecorder.start();
            return;
          }

          updateUIState("Processing");

          if (currentActionType === "Ask") {
            aiResponseArea.innerHTML = "";
            currentConversationHistory = [];
          }

          displayMessage(transcript, "user");
          currentConversationHistory.push({
            role: "user",
            content: transcript,
          });

          await streamLLMResponse();
        } catch (error) {
          displayError(error.message || "Failed to process audio.");
          updateUIState("Listening");
        } finally {
          if (
            appStatus === "Listening" &&
            mediaRecorder &&
            mediaRecorder.state === "inactive"
          ) {
            try {
              mediaRecorder.start();
            } catch (e) {}
          }
        }
      };
    } catch (err) {
      displayError(
        "Could not access microphone. Please check permissions. " + err.message
      );
      updateUIState("Ready");
    }
  }

  startButton.addEventListener("click", async () => {
    if (!BASE_URL) {
      displayError("Backend server is not ready. Please wait or restart.");
      return;
    }
    updateUIState("Listening");
    if (!mediaRecorder) {
      await setupAudioRecorder();
    }
    if (mediaRecorder && mediaRecorder.state === "inactive") {
      audioChunks = [];
      try {
        mediaRecorder.start();
      } catch (e) {
        displayError("Mic start failed: " + e.message);
        updateUIState("Ready");
      }
    }
  });

  let currentActionType = "";

  async function handleActionButtonClick(actionType) {
    if (!mediaRecorder) {
      displayError("Audio recorder not ready. Click 'Start Listening'.");
      return;
    }
    if (!BASE_URL) {
      displayError("Backend server is not ready. Please wait or restart.");
      return;
    }

    currentActionType = actionType;
    askButton.disabled = true;
    extendButton.disabled = true;

    if (mediaRecorder.state === "recording") {
      try {
        mediaRecorder.stop();
      } catch (e) {
        displayError("Problem stopping recording: " + e.message);
        updateUIState("Listening");
      }
    } else {
      audioChunks = [];
      try {
        mediaRecorder.start();
        displayMessage(
          "(Please speak after the prompt, then click 'Question' or 'Follow-up'.)",
          "laugh"
        );
        updateUIState("Listening");
        askButton.disabled = false;
        extendButton.disabled = currentConversationHistory.length === 0;
      } catch (e) {
        displayError("Problem with audio recording: " + e.message);
        updateUIState("Listening");
      }
    }
  }

  askButton.addEventListener("click", () => handleActionButtonClick("Ask"));
  extendButton.addEventListener("click", () =>
    handleActionButtonClick("Extend")
  );

  function scrollToBottom() {
    const userMessages = aiResponseContainer.querySelectorAll(".user-message");
    if (userMessages.length > 0) {
      const lastUser = userMessages[userMessages.length - 1];
      lastUser.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  async function streamLLMResponse() {
    if (!BASE_URL) {
      displayError("Backend server URL not configured. Cannot query LLM.");
      updateUIState("Listening");
      return;
    }
    let laughResponseSpan = displayMessage("", "laugh");
    let fullLaughResponse = "";

    try {
      const response = await fetch(`${BASE_URL}/query-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationHistory: currentConversationHistory,
        }),
      });
      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: "Unknown LLM error" }));
        throw new Error(
          errorData.detail || `LLM query failed: ${response.status}`
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let eolIndex;
        while ((eolIndex = buffer.indexOf("\n\n")) >= 0) {
          const messageLine = buffer.substring(0, eolIndex).trim();
          buffer = buffer.substring(eolIndex + 2);

          if (messageLine.startsWith("data: ")) {
            const jsonData = messageLine.substring("data: ".length);
            try {
              const parsedData = JSON.parse(jsonData);
              if (parsedData.text) {
                fullLaughResponse += parsedData.text;
                laughResponseSpan.innerHTML = sanitizeHTML(
                  marked.parse(fullLaughResponse)
                );
                scrollToBottom();
              } else if (parsedData.error) {
                displayError(`LLM Error: ${parsedData.error}`);
                if (laughResponseSpan.innerHTML.trim() === "")
                  laughResponseSpan.remove();
                throw new Error(parsedData.error);
              } else if (parsedData.event === "done") {
                currentConversationHistory.push({
                  role: "assistant",
                  content: fullLaughResponse,
                });
                laughResponseSpan.innerHTML = sanitizeHTML(
                  marked.parse(fullLaughResponse)
                );
                scrollToBottom();
                updateUIState("Listening");
                if (
                  mediaRecorder?.state === "inactive" &&
                  appStatus === "Listening"
                )
                  mediaRecorder.start();
                return;
              }
            } catch (e) {
              console.error("Error processing streamed data:", e);
              if (!e.message.includes("LLM Error")) {
                displayError("Error parsing LLM response stream.");
              }
              if (laughResponseSpan.innerHTML.trim() === "")
                laughResponseSpan.remove();
              throw e;
            }
          }
        }
      }
      currentConversationHistory.push({
        role: "assistant",
        content: fullLaughResponse,
      });
      laughResponseSpan.innerHTML = sanitizeHTML(
        marked.parse(fullLaughResponse)
      );
      scrollToBottom();
    } catch (error) {
      if (
        !error.message.includes("LLM Error") &&
        !error.message.includes("parsing LLM response")
      ) {
        displayError(error.message || "Failed to get response from AI.");
      }
      if (laughResponseSpan && laughResponseSpan.innerHTML.trim() === "") {
        laughResponseSpan.remove();
      } else if (laughResponseSpan) {
      }
    } finally {
      if (appStatus !== "Listening") {
        updateUIState("Listening");
      }
      if (
        mediaRecorder &&
        mediaRecorder.state === "inactive" &&
        appStatus === "Listening"
      ) {
        try {
          mediaRecorder.start();
        } catch (e) {}
      }
    }
  }

  stopButton.addEventListener("click", () => {
    cancelledRecording = true;
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try {
        mediaRecorder.stop();
      } catch (e) {}
    }
    currentConversationHistory = [];
    updateUIState("Ready");
  });

  window.addEventListener("keydown", (e) => {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "I" || e.key === "i")
    ) {
      e.preventDefault();
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === "F12" || e.key === "r" || e.key === "R")
    ) {
      e.preventDefault();
    }
    if (e.key === "F5") {
      e.preventDefault();
    }
  });

  updateUIState("Ready");

  // SETTINGS MENU LOGIC
  const settingsButton = document.getElementById("settingsButton");
  const settingsModal = document.getElementById("settingsModal");
  const saveSettingsButton = document.getElementById("saveSettingsButton");
  const cancelSettingsButton = document.getElementById("cancelSettingsButton");
  const geminiKeyInput = document.getElementById("geminiKey");
  const groqKeyInput = document.getElementById("groqKey");

  // Open settings modal when Settings button is clicked
  settingsButton.addEventListener("click", () => {
    // Prefill from localStorage if exists
    geminiKeyInput.value = localStorage.getItem("GEMINI_API_KEY") || "";
    groqKeyInput.value = localStorage.getItem("GROQ_API_KEY") || "";
    settingsModal.style.opacity = "1";
    settingsModal.style.pointerEvents = "all";
  });

  cancelSettingsButton.addEventListener("click", () => {
    settingsModal.style.opacity = "0";
    settingsModal.style.pointerEvents = "none";
  });

  saveSettingsButton.addEventListener("click", async () => {
    const geminiKey = geminiKeyInput.value.trim();
    const groqKey = groqKeyInput.value.trim();
    localStorage.setItem("GEMINI_API_KEY", geminiKey);
    localStorage.setItem("GROQ_API_KEY", groqKey);
    if (!geminiKey || !groqKey) {
      displayError("Both API keys are required.");
      return;
    }
    try {
      const response = await fetch(`${BASE_URL}/update-api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiKey, groqKey }),
      });
      if (!response.ok) throw new Error("Failed to update API keys on server.");
    } catch (error) {
      displayError(error.message);
    }
    settingsModal.style.opacity = "0";
    settingsModal.style.pointerEvents = "none";
  });
});
