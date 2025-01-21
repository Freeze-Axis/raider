let process = false;
document.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("botForm");

  // 入力内容を保存する関数
  function saveFormData() {
    const formData = {};
    new FormData(form).forEach((value, key) => {
      formData[key] = value;
    });
    localStorage.setItem("botFormData", JSON.stringify(formData));
  }

  // 保存されたデータを復元する関数
  function loadFormData() {
    const savedData = localStorage.getItem("botFormData");
    if (savedData) {
      const formData = JSON.parse(savedData);
      Object.keys(formData).forEach((key) => {
        const element = form.elements[key];
        if (element) {
          if (element.type === "checkbox") {
            element.checked = formData[key] === "on";
          } else {
            element.value = formData[key];
          }
        }
      });
    }
  }

  // フォームの変更を監視して保存
  form.addEventListener("input", saveFormData);

  // ページ読み込み時にデータを復元
  loadFormData();

  // 送信時にローカルストレージをクリア（必要なら削除）
  form.addEventListener("submit", function () {
    localStorage.removeItem("botFormData");
  });
});

let isStopped = false;
let lastErrorMessage = ""; // 直前のエラーメッセージを保存して連続表示を防ぐ

function updateStatus(message, isError = false) {
  if (message === lastErrorMessage) return; // 同じエラーメッセージを繰り返し表示しない
  lastErrorMessage = message;

  const statusElement = document.getElementById("status");
  const newMessage = document.createElement("div");
  newMessage.innerText = message;
  newMessage.style.color = isError ? "red" : "white";
  statusElement.appendChild(newMessage);
}

function generateRandomString(length) {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

async function sendPollData(pollData, channelIdsList, token) {
  const headers = {
    Authorization: token,
    "Content-Type": "application/json",
  };

  for (const channelId of channelIdsList) {
    try {
      const response = await retryRequest(() =>
        axios.post(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          pollData,
          { headers }
        )
      );

      if (response && response.data) {
        return response;
      } else {
        throw new Error("レスポンスデータが無効です");
      }
    } catch (error) {
      if (error.message === "Network Error") {
        updateStatus(`ネットワークエラーが発生しました。再試行します。`, true);
      } else {
        updateStatus(`投票送信エラー: ${error.message}`, true);
      }
    }
  }
}

async function sendMessageToChannels(finalMessage, channelIdsList, token) {
  const headers = {
    Authorization: token,
    "Content-Type": "application/json",
  };

  for (const channelId of channelIdsList) {
    try {
      const messageData = { content: finalMessage };
      const response = await retryRequest(() =>
        axios.post(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          messageData,
          { headers }
        )
      );

      if (!response || !response.data) {
        throw new Error("レスポンスデータが無効です");
      }
    } catch (error) {
      if (error.message === "Network Error") {
        updateStatus(`ネットワークエラーが発生しました。再試行します。`, true);
      } else {
        updateStatus(`メッセージ送信エラー: ${error.message}`, true);
      }
    }
  }
}

async function retryRequest(requestFunc, delay = 1000) {
  while (true) {
    try {
      return await requestFunc();
    } catch (error) {
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.data.retry_after || delay / 1000;
        console.warn(`Rate limit hit. Retrying after ${retryAfter} seconds.`);
        updateStatus(
          `レートリミットに達しました。${retryAfter}秒後に再試行します。`,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      } else if (error.message === "Network Error") {
        console.warn("ネットワークエラーが発生しました。再試行します。");
        updateStatus("ネットワークエラーが発生しました。再試行します。", true);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        updateStatus(`エラーが発生しました: ${error.message}`, true);
        throw error;
      }
    }
  }
}

document
  .getElementById("botForm")
  .addEventListener("submit", async function (event) {
    event.preventDefault();
    if (process) return;
    process = true;
    isStopped = false;
    const tokens = document
      .getElementById("token")
      .value.split("\n")
      .map((token) => token.trim())
      .filter((token) => token); // トークンを複数対応
    const serverId = document.getElementById("serverId").value;
    const messageContent = document.getElementById("messageContent").value;
    const delay =
      (parseFloat(document.getElementById("delay").value) || 0.1) * 1000;
    const sendToAllChannels =
      document.getElementById("sendToAllChannels").checked;
    const mentionRandomUsers =
      document.getElementById("mentionRandomUsers").checked;
    const appendRandomString =
      document.getElementById("appendRandomString").checked;
    const expirePoll = document.getElementById("expirePoll").checked; // チェックボックスの状態を取得
    const statusElement = document.getElementById("status");
    const pollDuration = document.getElementById("pollDuration").value;
    const pollQuestion = document.getElementById("pollQuestion").value;
    const pollAnswers = document
      .getElementById("pollAnswers")
      .value.split(",")
      .map((answer) => answer.trim());

    statusElement.innerText = "処理中...";

    try {
      let channelIdsList = [];

      if (sendToAllChannels) {
        const response = await retryRequest(() =>
          axios.get(`https://discord.com/api/v9/guilds/${serverId}/channels`, {
            headers: { Authorization: tokens[0] },
          })
        );

        if (response.data && response.data.length > 0) {
          channelIdsList = response.data
            .filter(
              (channel) =>
                channel.type === 0 || channel.type === 2 || channel.type === 5
            )
            .map((channel) => channel.id);

          document.getElementById("channelIds").value =
            channelIdsList.join("\n");
        } else {
          updateStatus("チャンネルが見つかりませんでした。", true);
          return;
        }
      } else {
        const channelIds = document
          .getElementById("channelIds")
          .value.split("\n")
          .map((id) => id.trim())
          .filter((id) => id);
        if (channelIds.length === 0) {
          updateStatus("チャンネルIDが入力されていません。", true);
          return;
        }
        channelIdsList = channelIds;
      }

      // トークンを順番に使用するためのインデックス
      let tokenIndex = 0;

      while (!isStopped) {
        let finalMessage = messageContent;

        if (mentionRandomUsers) {
          const membersResponse = await retryRequest(() =>
            axios.get(`https://discord.com/api/v9/guilds/${serverId}/members`, {
              headers: { Authorization: tokens[tokenIndex] }, // トークンインデックスを使用
            })
          );

          const members = membersResponse.data;
          const randomMembers = [];
          for (let i = 0; i < 3; i++) {
            const randomMember =
              members[Math.floor(Math.random() * members.length)];
            randomMembers.push(`<@${randomMember.user.id}>`);
          }

          finalMessage += " " + randomMembers.join(" ");
        }

        if (appendRandomString) {
          finalMessage += " " + generateRandomString(8);
        }

        let pollData = null;
        let pollChannelId = null;

        if (pollQuestion && pollAnswers.length > 0) {
          pollData = {
            content: finalMessage,
            poll: {
              question: { text: pollQuestion },
              answers: pollAnswers.map((answer) => ({
                poll_media: { text: answer },
              })),
              duration: pollDuration,
            },
            flags: 0,
          };
        }

        if (pollData) {
          try {
            const pollResponse = await retryRequest(
              () => sendPollData(pollData, channelIdsList, tokens[tokenIndex]) // トークンインデックスを使用
            );
            updateStatus("メッセージと投票を送信しました。");

            pollChannelId = pollResponse.data.channel_id;

            if (expirePoll) {
              const pollId = pollResponse.data.id;
              await retryRequest(() =>
                axios.post(
                  `https://discord.com/api/v9/channels/${pollChannelId}/polls/${pollId}/expire`,
                  {},
                  {
                    headers: { Authorization: tokens[tokenIndex] }, // トークンインデックスを使用
                  }
                )
              );
              updateStatus("投票を即時終了しました。");
            }
          } catch (error) {
            updateStatus(`エラーが発生しました: ${error.message}`, true);
          }
        } else {
          await retryRequest(
            () =>
              sendMessageToChannels(
                finalMessage,
                channelIdsList,
                tokens[tokenIndex]
              ) // トークンインデックスを使用
          );
          updateStatus("メッセージを送信しました。");
        }

        // 次のトークンに進む
        tokenIndex = (tokenIndex + 1) % tokens.length;

        await new Promise((resolve) => setTimeout(resolve, delay)); // ユーザー指定の間隔
      }

      updateStatus("メッセージ送信が停止しました。");
    } catch (error) {
      console.error("エラー:", error);
      updateStatus(`エラーが発生しました: ${error.message}`, true);
    }
  });

document.getElementById("stopButton").addEventListener("click", function () {
  isStopped = true;
  updateStatus("処理が停止しました。");
  process = false;
});
