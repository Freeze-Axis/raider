(function(){
    "use strict";
    
    // ────────────── 停止処理対応 ──────────────
    let isStopped = false;
    let threadIsStopped = false;
    
    function sleepWithStop(ms, stopChecker) {
      return new Promise(resolve => {
        const start = Date.now();
        function check() {
          if (stopChecker()) {
            resolve();
          } else if (Date.now() - start >= ms) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        }
        check();
      });
    }
    
    async function retryRequest(requestFunc, delay = 1000, stopChecker = () => false) {
      while (true) {
        if (stopChecker()) {
          throw new Error("処理停止されました。");
        }
        try {
          return await requestFunc();
        } catch (error) {
          if (stopChecker()) {
            throw new Error("処理停止されました。");
          }
          if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            throw error;
          } else if (error.response && error.response.status === 429) {
            const retryAfter = error.response.data.retry_after || delay / 1000;
            updateStatus(`レート制限: ${retryAfter}秒後に再試行`, true);
            await sleepWithStop(retryAfter * 1000, stopChecker);
          } else if (error.message === "Network Error") {
            updateStatus("ネットワークエラー。再試行します。", true);
            await sleepWithStop(delay, stopChecker);
          } else {
            updateStatus(`エラー: ${error.message}`, true);
            await sleepWithStop(delay, stopChecker);
          }
        }
      }
    }
    
    // ────────────── ヘルパー関数 ──────────────
    function getTokens() {
      return tokenInput.value.split("\n").map(t => t.trim()).filter(t => t);
    }
    
    function generateMentionString(userIdsText, count) {
      const userIds = userIdsText.split("\n").map(id => id.trim()).filter(id => id);
      if (!userIds.length) return "";
      const effectiveCount = Math.min(count, userIds.length);
      const shuffled = userIds.slice().sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, effectiveCount);
      const mentions = selected.map(id => `<@${id}>`);
      const lines = [];
      for (let i = 0; i < mentions.length; i += 3) {
        lines.push(mentions.slice(i, i + 3).join(" "));
      }
      return lines.join("\n");
    }
    
    function checkAndRemoveInvalidToken(error, tokens, index) {
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        updateStatus(`TOKEN[${tokens[index]}]は使用不可と判断されました。以降このTOKENではリクエストを行いません。`, true);
        tokens.splice(index, 1);
        return true;
      }
      return false;
    }
    
    function throwIfInvalidToken(error, token) {
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        updateStatus(`TOKEN[${token}]は使用不可と判断されたため、以降のリクエストは送信しません。`, true);
        throw error;
      }
    }
    
    async function getChannelsForServer(serverId, tokens, stopChecker = () => isStopped) {
      for (let i = 0; i < tokens.length; i++) {
        try {
          const resp = await retryRequest(() =>
            axios.get(`https://discord.com/api/v9/guilds/${serverId}/channels`, {
              headers: { Authorization: tokens[i] }
            }), 1000, stopChecker);
          const channels = resp.data.filter(ch => [0, 2, 5].includes(ch.type)).map(ch => ch.id);
          if (channels.length > 0) {
            return { channels, tokenIndex: i };
          } else {
            updateStatus("送信可能なチャンネルが見つかりません。", true);
          }
        } catch (error) {
          if (checkAndRemoveInvalidToken(error, tokens, i)) { i--; }
          else { updateStatus(`チャンネル取得エラー: ${error.message}`, true); }
        }
      }
      return null;
    }
    
    // ────────────── 既存処理 ──────────────
    
    // アコーディオン状態管理
    const savedAccordionStates = JSON.parse(localStorage.getItem("accordionStates") || "{}");
    document.querySelectorAll('.accordion').forEach(accordion => {
      const header = accordion.querySelector('.accordion-header');
      const content = accordion.querySelector('.accordion-content');
      const icon = header.querySelector('.toggle-icon');
      const id = accordion.id;
      if (savedAccordionStates[id]) {
        content.classList.add('active');
        icon.textContent = '−';
      } else {
        content.classList.remove('active');
        icon.textContent = '＋';
      }
      header.addEventListener('click', function() {
        if (content.classList.contains('active')) {
          content.classList.remove('active');
          icon.textContent = '＋';
          savedAccordionStates[id] = false;
        } else {
          content.classList.add('active');
          icon.textContent = '−';
          savedAccordionStates[id] = true;
        }
        localStorage.setItem("accordionStates", JSON.stringify(savedAccordionStates));
      });
    });
    
    // フォーム自動保存
    let processRunning = false;
    let lastErrorMessage = "";
    const form = document.getElementById("botForm");
    function saveFormData() {
      const formData = {};
      new FormData(form).forEach((value, key) => { formData[key] = value; });
      localStorage.setItem("botFormData", JSON.stringify(formData));
    }
    function loadFormData() {
      const saved = localStorage.getItem("botFormData");
      if (saved) {
        const data = JSON.parse(saved);
        Object.keys(data).forEach(key => {
          if (form.elements[key]) {
            if (form.elements[key].type === "checkbox") {
              form.elements[key].checked = data[key] === "on";
            } else {
              form.elements[key].value = data[key];
            }
          }
        });
      }
    }
    form.addEventListener("input", saveFormData);
    loadFormData();
    
    const sendAllCheckbox = document.getElementById("sendToAllChannels");
    const manualChannelDiv = document.getElementById("manualChannelDiv");
    function updateChannelInput() {
      manualChannelDiv.style.display = sendAllCheckbox.checked ? "none" : "block";
    }
    sendAllCheckbox.addEventListener("change", updateChannelInput);
    updateChannelInput();
    
    const includePollCheckbox = document.getElementById("includePoll");
    const pollFields = document.getElementById("pollFields");
    pollFields.style.display = includePollCheckbox.checked ? "block" : "none";
    includePollCheckbox.addEventListener("change", function() {
      pollFields.style.display = this.checked ? "block" : "none";
    });
    
    document.getElementById("stopButton").disabled = true;
    document.getElementById("stopThreadBtn").disabled = true;
    
    // ログ更新
    function updateStatus(message, isError = false) {
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      const statusEl = document.getElementById("status");
      const div = document.createElement("div");
      div.innerText = message;
      div.style.color = isError ? "#ff6b6b" : "#e0e0e0";
      statusEl.appendChild(div);
      statusEl.scrollTop = statusEl.scrollHeight;
    }
    
    function generateRandomString(length) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let result = "";
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    }
    
    // メッセージ送信処理用関数（停止チェック付き）
    async function sendMessageToChannels(message, channelIds, token) {
      const headers = { Authorization: token, "Content-Type": "application/json" };
      for (const channelId of channelIds) {
        try {
          const data = { content: message };
          await retryRequest(() => axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, data, { headers }), 1000, () => isStopped);
        } catch (error) {
          throwIfInvalidToken(error, token);
          updateStatus(`チャンネル ${channelId} への送信エラー: ${error.message}`, true);
        }
      }
    }
    
    async function sendPollData(pollData, channelIds, token) {
      const headers = { Authorization: token, "Content-Type": "application/json" };
      for (const channelId of channelIds) {
        try {
          const response = await retryRequest(() =>
            axios.post(`https://discord.com/api/v10/channels/${channelId}/messages`, pollData, { headers }), 1000, () => isStopped);
          if (response && response.data) return response;
          else throw new Error("無効なレスポンス");
        } catch (error) {
          throwIfInvalidToken(error, token);
          updateStatus(`チャンネル ${channelId} への投票送信エラー: ${error.message}`, true);
        }
      }
    }
    
    // ユーザーID取得処理
    document.getElementById("fetchUserIdsButton").addEventListener("click", async function () {
      const serverId = document.getElementById("serverId").value.trim();
      const tokenVal = getTokens()[0] || "";
      if (!serverId) { updateStatus("サーバーIDを入力してください。", true); return; }
      if (!tokenVal) { updateStatus("Botトークンを入力してください。", true); return; }
      
      let tokens = getTokens();
      const channelRes = await getChannelsForServer(serverId, tokens, () => false);
      if (!channelRes) {
        updateStatus("使用可能なTOKENがないためメッセージ送信をスキップします。", true);
        return;
      }
      const channelIds = channelRes.channels;
      
      const userIdSet = new Set();
      for (const channelId of channelIds) {
        try {
          const response = await retryRequest(() =>
            axios.get(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, { headers: { Authorization: tokenVal } }), 1000, () => false);
          const messages = response.data;
          messages.forEach(msg => { if (msg.author && msg.author.id) userIdSet.add(msg.author.id); });
        } catch (error) { }
      }
      const userIds = Array.from(userIdSet);
      document.getElementById("userIds").value = userIds.join("\n");
      updateStatus(`ユーザーID ${userIds.length} 件取得しました。`);
    });
    
    // メッセージ送信処理
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (processRunning) return;
      processRunning = true;
      isStopped = false;
  
      const execBtn = document.getElementById("executeBtn");
      const stopBtn = document.getElementById("stopButton");
      execBtn.disabled = true;
      stopBtn.disabled = false;
  
      let tokens = getTokens();
      if(tokens.length === 0) { updateStatus("使用可能なTOKENがありません。", true); processRunning = false; return; }
  
      const serverId = document.getElementById("serverId").value.trim();
      const baseMessage = document.getElementById("messageContent").value;
      const delayEnabled = document.getElementById("enableDelay").checked;
      const delay = delayEnabled ? (parseInt(document.getElementById("delay").value, 10) || 0) : 0;
      const appendRandomString = document.getElementById("appendRandomString").checked;
      const mentionRandomUsers = document.getElementById("mentionRandomUsers").checked;
      let mentionCount = parseInt(document.getElementById("mentionCount").value, 10) || 1;
      mentionCount = Math.min(Math.max(mentionCount, 1), 50);
  
      const includePoll = document.getElementById("includePoll").checked;
      const pollQuestion = document.getElementById("pollQuestion").value;
      const pollAnswers = document.getElementById("pollAnswers").value.split(",").map(a => a.trim()).filter(a => a);
      const pollDuration = document.getElementById("pollDuration").value;
      const expirePoll = document.getElementById("expirePoll").checked;
  
      const sendToAllChannels = document.getElementById("sendToAllChannels").checked;
      const manualChannelsText = document.getElementById("channelIds").value.trim();
      const userIdsText = document.getElementById("userIds").value;
  
      let channelsList = [];
      if (sendToAllChannels) {
        const channelRes = await getChannelsForServer(serverId, tokens);
        if (!channelRes) {
          updateStatus("使用可能なTOKENがないためメッセージ送信をスキップします。", true);
          processRunning = false;
          execBtn.disabled = false;
          stopBtn.disabled = true;
          return;
        }
        channelsList = channelRes.channels;
      } else {
        const manualIds = manualChannelsText.split("\n").map(id => id.trim()).filter(id => id);
        if (manualIds.length === 0) { updateStatus("チャンネルIDが入力されていません。", true); processRunning = false; return; }
        channelsList = manualIds;
      }
  
      updateStatus("処理中...");
      let tokenIndex = 0;
      while (!isStopped) {
        if(tokens.length === 0) {
          updateStatus("使用可能なTOKENがなくなりました。");
          break;
        }
        let finalMessage = baseMessage;
        if (mentionRandomUsers) {
          if (userIdsText && userIdsText.trim() !== "") {
            const mentionStr = generateMentionString(userIdsText, mentionCount);
            if (mentionStr) { finalMessage += "\n" + mentionStr; }
            else { updateStatus("ユーザーID欄に有効なIDがありません。ランダムメンションはスキップされました。"); }
          } else {
            updateStatus("ユーザーIDが指定されていないため、ランダムメンションはスキップされました。");
          }
        }
        if (appendRandomString) { finalMessage += " " + generateRandomString(8); }
  
        let pollData = null;
        if (includePoll) {
          if (pollQuestion && pollAnswers.length > 0) {
            pollData = {
              content: finalMessage,
              poll: {
                question: { text: pollQuestion },
                answers: pollAnswers.map(answer => ({ poll_media: { text: answer } })),
                duration: pollDuration
              },
              flags: 0
            };
          }
        }
  
        let targetChannels = [];
        const randomIndex = Math.floor(Math.random() * channelsList.length);
        targetChannels.push(channelsList[randomIndex]);
  
        try {
          if (pollData) {
            const pollResp = await retryRequest(() =>
              sendPollData(pollData, targetChannels, tokens[tokenIndex]),
              1000,
              () => isStopped
            );
            updateStatus("メッセージ＋投票を送信しました。");
            if (expirePoll && pollResp && pollResp.data) {
              const pollId = pollResp.data.id;
              const channelId = pollResp.data.channel_id;
              await retryRequest(() =>
                axios.post(`https://discord.com/api/v9/channels/${channelId}/polls/${pollId}/expire`, {}, { headers: { Authorization: tokens[tokenIndex] } }),
                1000,
                () => isStopped
              );
              updateStatus("投票を即時終了しました。");
            }
          } else {
            await retryRequest(() =>
              sendMessageToChannels(finalMessage, targetChannels, tokens[tokenIndex]),
              1000,
              () => isStopped
            );
            updateStatus("メッセージを送信しました。");
          }
        } catch (error) {
          if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            updateStatus(`TOKEN[${tokens[tokenIndex]}] は使用不可と判断されました。`, true);
            tokens.splice(tokenIndex, 1);
            if(tokens.length === 0) {
              updateStatus("使用可能なTOKENがなくなりました。", true);
              break;
            }
            tokenIndex = tokenIndex % tokens.length;
            continue;
          } else {
            updateStatus(`送信エラー: ${error.message}`, true);
          }
        }
        tokenIndex = (tokenIndex + 1) % tokens.length;
        await sleepWithStop(delay, () => isStopped);
      }
      updateStatus("メッセージ送信が停止しました。");
      processRunning = false;
      execBtn.disabled = false;
      stopBtn.disabled = true;
    });
    
    document.getElementById("stopButton").addEventListener("click", function () {
      isStopped = true;
      updateStatus("処理を停止しました。");
      processRunning = false;
      document.getElementById("executeBtn").disabled = false;
      this.disabled = true;
    });
    
    // スレッド作成処理
    let threadProcessRunning = false;
    document.getElementById("startThreadBtn").addEventListener("click", async function () {
      if (threadProcessRunning) return;
      threadProcessRunning = true;
      threadIsStopped = false;
      document.getElementById("startThreadBtn").disabled = true;
      document.getElementById("stopThreadBtn").disabled = false;
      
      const threadTitle = document.getElementById("threadTitle").value.trim();
      const threadMessage = document.getElementById("threadMessage").value;
      const threadCount = Number(document.getElementById("threadCount").value) || 1;
      const threadDelayEnabled = document.getElementById("threadEnableDelay").checked;
      const threadDelay = threadDelayEnabled ? (Number(document.getElementById("threadDelay").value) || 0) : 0;
      let tokens = getTokens();
      if (tokens.length === 0) { updateStatus("使用可能なTOKENがありません。", true); threadProcessRunning = false; return; }
      
      let targetChannelId = "";
      const sendToAllChannels = document.getElementById("sendToAllChannels").checked;
      const manualChannelsText = document.getElementById("channelIds").value.trim();
      const serverId = document.getElementById("serverId").value.trim();
      
      if (manualChannelsText) {
        targetChannelId = manualChannelsText.split("\n")[0].trim();
      } else if (sendToAllChannels && serverId) {
        const channelRes = await getChannelsForServer(serverId, tokens);
        if (!channelRes) {
          updateStatus("使用可能なTOKENがないためスレッド作成をスキップします。", true);
          threadProcessRunning = false;
          document.getElementById("startThreadBtn").disabled = false;
          document.getElementById("stopThreadBtn").disabled = true;
          return;
        }
        targetChannelId = channelRes.channels[0];
      } else {
        updateStatus("チャンネルIDまたはサーバーIDが必要です。", true);
        threadProcessRunning = false;
        return;
      }
      
      let actualThreadType = 11;
      try {
        const channelResp = await retryRequest(() =>
          axios.get(`https://discord.com/api/v9/channels/${targetChannelId}`, {
            headers: { Authorization: tokens[0] }
          }), 1000, () => threadIsStopped);
        const chType = channelResp.data.type;
        actualThreadType = (chType === 5) ? 10 : 11;
        updateStatus(`対象チャンネルタイプ ${chType} により、スレッドtype を ${actualThreadType} に設定しました。`);
      } catch (error) {
        updateStatus(`チャンネル情報取得エラー: ${error.message}`, true);
      }
      
      updateStatus("スレッド作成処理開始...");
      
      const threadMentionRandomUsers = document.getElementById("threadMentionRandomUsers").checked;
      let threadMentionCount = parseInt(document.getElementById("threadMentionCount").value, 10) || 1;
      threadMentionCount = Math.min(Math.max(threadMentionCount, 1), 50);
      
      let threadTokenIndex = 0;
      for (let i = 0; i < threadCount; i++) {
        if (threadIsStopped) break;
        try {
          const payload = {
            name: threadTitle,
            type: actualThreadType,
            auto_archive_duration: 4320,
            location: "Thread Browser Toolbar"
          };
          const threadResp = await retryRequest(() =>
            axios.post(`https://discord.com/api/v9/channels/${targetChannelId}/threads`, payload, {
              headers: { Authorization: tokens[threadTokenIndex], "Content-Type": "application/json" }
            }), 1000, () => threadIsStopped);
          if(threadIsStopped) break;
          updateStatus(`スレッド "${threadTitle}" 作成完了 (${i+1}/${threadCount})`);
          
          if (threadMessage.trim() && threadResp.data && threadResp.data.id) {
            let finalThreadMessage = threadMessage;
            if (threadMentionRandomUsers) {
              const userIdsText = document.getElementById("userIds").value;
              if (userIdsText && userIdsText.trim() !== "") {
                const mentionStr = generateMentionString(userIdsText, threadMentionCount);
                if (mentionStr) { finalThreadMessage += "\n" + mentionStr; }
                else { updateStatus("ユーザーID欄に有効なIDがありません。スレッド内のランダムメンションはスキップされました。"); }
              } else {
                updateStatus("ユーザーIDが指定されていないため、スレッド内のランダムメンションはスキップされました。");
              }
            }
            if(threadIsStopped) break;
            const msgPayload = { content: finalThreadMessage };
            await retryRequest(() =>
              axios.post(`https://discord.com/api/v10/channels/${threadResp.data.id}/messages`, msgPayload, {
                headers: { Authorization: tokens[threadTokenIndex], "Content-Type": "application/json" }
              }), 1000, () => threadIsStopped);
            if(threadIsStopped) break;
            updateStatus(`スレッド内メッセージ送信完了 (${i+1}/${threadCount})`);
          }
        } catch (error) {
          if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            updateStatus(`TOKEN[${tokens[threadTokenIndex]}] はスレッド作成に使用不可と判断されました。`, true);
            tokens.splice(threadTokenIndex, 1);
            if(tokens.length === 0) {
              updateStatus("使用可能なTOKENがなくなりました。", true);
              break;
            }
            threadTokenIndex = threadTokenIndex % tokens.length;
            continue;
          } else {
            updateStatus(`スレッド作成エラー: ${error.message}`, true);
          }
        }
        threadTokenIndex = (threadTokenIndex + 1) % tokens.length;
        await sleepWithStop(threadDelay, () => threadIsStopped);
      }
      
      updateStatus("スレッド作成処理が終了しました。");
      threadProcessRunning = false;
      document.getElementById("startThreadBtn").disabled = false;
      document.getElementById("stopThreadBtn").disabled = true;
    });
    
    document.getElementById("stopThreadBtn").addEventListener("click", function () {
      threadIsStopped = true;
      updateStatus("スレッド送信を停止しました。");
      document.getElementById("startThreadBtn").disabled = false;
      this.disabled = true;
    });
    
  })();
  