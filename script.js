let isPlaying = false
let queue = []
let currentUser = localStorage.getItem("musicPlayerUsername") || ""
let connectedUsers = []
let currentSong = null
let playerState = { is_playing: false, volume: 0.8, current_time: 0, duration: 0 }
let mainPlayerConnected = false
const io = window.io
const socket = io() // Declare the socket variable

// Check if this is the main player or remote control
const isMainPlayer = window.isMainPlayer || false

// Progress update interval
let progressInterval = null

// Notification functions
function showNotification(message, type = "error", duration = 5000) {
  const notificationArea = document.getElementById("notification-area")
  const notificationContent = document.getElementById("notification-content")
  const notificationMessage = document.getElementById("notification-message")

  if (!notificationArea || !notificationContent || !notificationMessage) {
    // Fallback to console if notification elements don't exist
    console.log(`${type.toUpperCase()}: ${message}`)
    return
  }

  // Set message and type
  notificationMessage.textContent = message

  // Remove existing type classes
  notificationContent.classList.remove("success", "warning", "info", "error")

  // Add new type class
  if (type !== "error") {
    notificationContent.classList.add(type)
  }

  // Show notification
  notificationArea.style.display = "block"
  notificationArea.classList.remove("hiding")

  // Auto-hide after duration
  if (duration > 0) {
    setTimeout(() => {
      hideNotification()
    }, duration)
  }
}

function hideNotification() {
  const notificationArea = document.getElementById("notification-area")
  if (notificationArea) {
    notificationArea.classList.add("hiding")
    setTimeout(() => {
      notificationArea.style.display = "none"
      notificationArea.classList.remove("hiding")
    }, 300)
  }
}

// Debug function
function debugLog(message, data = null) {
  const logMessage = `[${isMainPlayer ? "MAIN" : "REMOTE"}] ${message}`
  console.log(logMessage, data || "")

  // Send debug message to server
  socket.emit("debug_message", {
    type: isMainPlayer ? "main_player" : "remote",
    message: message,
    data: data,
  })
}

// Escape HTML characters
function htmlEscape(str) {
  return String(str)
    .replace(/\\/g, "\\\\") // escape backslashes
    .replace(/'/g, "\\'") // escape single quotes for JS string in single quotes
    .replace(/"/g, '\\"') // escape double quotes (optional safety)
    .replace(/\n/g, "\\n") // escape newlines
    .replace(/\r/g, "\\r") // escape carriage returns
    .replace(/</g, "&lt;") // HTML escape for safety
    .replace(/>/g, "&gt;") // HTML escape for safety
    .replace(/&/g, "&amp;") // HTML escape ampersands
}

// Format time in MM:SS
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

// Set username
function setUsername() {
  const usernameInput = document.getElementById("username")
  if (usernameInput) {
    const username = usernameInput.value.trim()
    if (username) {
      currentUser = username
      localStorage.setItem("musicPlayerUsername", username)
      socket.emit("join_room", { username: username, is_main_player: isMainPlayer })
      usernameInput.style.display = "none"
      usernameInput.nextElementSibling.style.display = "none"

      // Show logout button
      const logoutBtn = document.getElementById("logout-btn")
      if (logoutBtn) {
        logoutBtn.style.display = "inline-block"
      }

      showNotification(`Welcome, ${username}!`, "success", 3000)
    }
  }
}

// Search for songs with improved error handling
async function search() {
  const query = document.getElementById("query").value.trim()
  if (!query) return

  const searchType = document.querySelector('input[name="searchType"]:checked').value // Get selected search type

  const searchBtn = document.getElementById("search-btn")
  const loadingEl = document.getElementById("search-loading")
  const resultsContainer = document.getElementById("search-results-container")

  searchBtn.disabled = true
  searchBtn.textContent = "Searching..."
  loadingEl.style.display = "block"

  try {
    const res = await fetch(`/api/search?query=${encodeURIComponent(query)}&type=${searchType}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json()

    if (data.error) {
      throw new Error(data.error)
    }

    displaySearchResults(data)
    if (resultsContainer) {
      resultsContainer.style.display = "block"
    }
    showNotification(`Found ${data.length} results for "${query}"`, "success", 3000)
  } catch (error) {
    console.error("Search error:", error)
    showNotification(`Search failed: ${error.message}`, "error")
  } finally {
    searchBtn.disabled = false
    searchBtn.textContent = "Search"
    loadingEl.style.display = "none"
  }
}

// Display search results - works for both pages
function displaySearchResults(results) {
  const grid = document.getElementById("search-results-grid")

  if (grid) {
    // Use grid layout (modern)
    grid.innerHTML = results
      .map((song) => {
        return `
        <div class="search-result-card">
          <img src="${song.thumbnail}" alt="Thumbnail" loading="lazy" class="result-thumbnail">
          <div class="result-info">
            <h4 class="result-title">${song.title}</h4>
            <p class="result-artist">${song.artist}</p>
            <p class="result-duration">${song.duration}</p>
            <button onclick="addToQueue('${htmlEscape(song.videoId)}', '${htmlEscape(song.title)}', '${htmlEscape(song.artist)}', '${htmlEscape(song.duration)}', '${htmlEscape(song.thumbnail)}')" 
                    class="add-btn" data-video-id="${song.videoId}">
              ➕ Add to Queue
            </button>
          </div>
        </div>
      `
      })
      .join("")
  } else {
    // Fallback to table layout (legacy)
    const tbody = document.getElementById("search-results")?.getElementsByTagName("tbody")[0]
    if (tbody) {
      tbody.innerHTML = results
        .map((song) => {
          return `<tr>
              <td><img src="${song.thumbnail}" alt="Thumbnail" loading="lazy"></td>
              <td class="song-title">${htmlEscape(song.title)}</td>
              <td>${htmlEscape(song.artist)}</td>
              <td>${htmlEscape(song.duration)}</td>
              <td>
                  <button onclick="addToQueue('${htmlEscape(song.videoId)}', '${htmlEscape(song.title)}', '${htmlEscape(song.artist)}', '${htmlEscape(song.duration)}', '${htmlEscape(song.thumbnail)}')" 
                          class="add-btn" data-video-id="${song.videoId}">
                      ➕ Add
                  </button>
              </td>
          </tr>`
        })
        .join("")
    }
  }
}

// Add a song to the queue with improved feedback
async function addToQueue(videoId, title, artist, duration, thumbnail) {
  if (!currentUser) {
    const username = prompt("Please enter your name:")
    if (username) {
      currentUser = username.trim()
      localStorage.setItem("musicPlayerUsername", currentUser)
      socket.emit("join_room", { username: currentUser, is_main_player: isMainPlayer })
    } else {
      return
    }
  }

  const addButton = document.querySelector(`button[data-video-id="${videoId}"]`)
  if (addButton) {
    addButton.innerHTML = "⏳ Loading..."
    addButton.disabled = true
  }

  try {
    const response = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        title,
        artist,
        duration,
        thumbnail,
        requestedBy: currentUser,
      }),
    })

    const result = await response.json()

    if (result.error) {
      showNotification(result.error, "error")
    } else if (result.message === "Song already in queue") {
      showNotification("This song is already in the queue!", "warning")
        addButton.innerHTML = "✅ Added"
        setTimeout(() => {
          addButton.innerHTML = "➕ Add to Queue"
        }, 60000)
    } else {
      // Show success feedback
      if (addButton) {
        addButton.innerHTML = "✅ Added"
        setTimeout(() => {
          addButton.innerHTML = "➕ Add to Queue"
        }, 60000)
      }

      // Show different message based on whether auto-play happened
      if (result.auto_started) {
        showNotification(`Added "${title}" to queue and started playing`, "success", 4000)
      } else {
        showNotification(`Added "${title}" to queue`, "success", 3000)
      }
    }
  } catch (error) {
    console.error("Add to queue error:", error)
    showNotification("Failed to add song to queue. Please try again.", "error")
  } finally {
    if (addButton) {
      addButton.disabled = false
    }
  }
}

// Update the queue display - works for both layouts
function updateQueueDisplay() {
  // Try modern layout first
  const queueList = document.getElementById("queue-list")
  const queueCount = document.getElementById("queue-count")
  const queueEmpty = document.getElementById("queue-empty")

  if (queueCount) queueCount.textContent = `${queue.length} songs`

  if (queue.length === 0) {
    if (queueList) queueList.innerHTML = ""
    if (queueEmpty) queueEmpty.style.display = "block"

    // Also clear legacy table
    const tbody = document.getElementById("queue")?.getElementsByTagName("tbody")[0]
    if (tbody) tbody.innerHTML = ""
    return
  }

  if (queueEmpty) queueEmpty.style.display = "none"

  if (queueList) {
    // Modern card layout
    queueList.innerHTML = queue
      .map((song, index) => {
        return `
        <div class="queue-item">
          <div class="queue-position">${index + 1}</div>
          <img src="${song.thumbnail || "/placeholder.svg?height=50&width=50"}" alt="Thumbnail" class="queue-thumbnail">
          <div class="queue-info">
            <div class="queue-title">
              <span class="stream-status" title="Ready to play">🟢</span>
              ${song.title}
            </div>
            <div class="queue-artist">${song.artist}</div>
            <div class="queue-meta">
              <span>${htmlEscape(song.duration)}</span> • 
              <span class="requester">by ${song.requestedBy}</span>
            </div>
          </div>
          <button onclick="removeFromQueue('${song.id}')" class="remove-btn" title="Remove">
            🗑️
          </button>
        </div>
      `
      })
      .join("")
  } else {
    // Fallback to legacy table layout
    const tbody = document.getElementById("queue")?.getElementsByTagName("tbody")[0]
    if (tbody) {
      tbody.innerHTML = queue
        .map((song, index) => {
          return `<tr>
              <td class="queue-position">${index + 1}</td>
              <td><img src="${song.thumbnail || "/placeholder.svg?height=50&width=50"}" alt="Thumbnail" loading="lazy"></td>
              <td class="song-title">
                  <span title="Ready to play">🟢</span>
                  ${htmlEscape(song.title)}
              </td>
              <td>${htmlEscape(song.artist)}</td>
              <td>${htmlEscape(song.duration)}</td>
              <td class="requester">${htmlEscape(song.requestedBy)}</td>
              <td>
                  <button onclick="removeFromQueue('${song.id}')" class="remove-btn" title="Remove from queue">
                      🗑️
                  </button>
              </td>
          </tr>`
        })
        .join("")
    }
  }
}

// Remove a song from the queue
async function removeFromQueue(songId) {
  try {
    await fetch(`/api/queue?id=${songId}`, {
      method: "DELETE",
    })
    showNotification("Song removed from queue", "info", 2000)
  } catch (error) {
    console.error("Remove from queue error:", error)
    showNotification("Failed to remove song from queue", "error")
  }
}

// Player control functions
async function togglePlayPause() {
  if (isMainPlayer) {
    // Main player controls audio directly
    const audio = document.getElementById("audioPlayer")
    if (!audio.src && queue.length > 0) {
      await playNext()
      return
    }
    if (!audio.src) {
      showNotification("No song loaded. Add songs to the queue first.", "info")
      return
    }

    try {
      if (audio.paused) {
        await audio.play()
        isPlaying = true
        startProgressSync()
      } else {
        audio.pause()
        isPlaying = false
        stopProgressSync()
      }
      updatePlayPauseButton()

      // Update server state
      playerState.is_playing = isPlaying
      socket.emit("time_sync", {
        current_time: audio.currentTime,
        is_playing: isPlaying,
      })
    } catch (error) {
      console.error("Toggle error:", error)
      showNotification("Failed to toggle playback", "error")
    }
  } else {
    // Remote control sends command to server
    await remoteTogglePlayPause()
  }
}

async function changeVolume(value) {
  if (isMainPlayer) {
    const audio = document.getElementById("audioPlayer")
    const volumeValue = document.getElementById("volumeValue")

    audio.volume = value / 100
    if (volumeValue) volumeValue.textContent = `${value}%`
  }

  // Always send to server for sync
  try {
    await fetch("/player/volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume: value / 100 }),
    })
  } catch (error) {
    console.error("Volume error:", error)
    showNotification("Failed to change volume", "error")
  }
}

// Queue management
async function shuffleQueue() {
  try {
    await fetch("/queue/shuffle", { method: "POST" })
    showNotification("Queue shuffled", "success", 2000)
  } catch (error) {
    console.error("Shuffle error:", error)
    showNotification("Failed to shuffle queue", "error")
  }
}

async function clearQueue() {
  if (confirm("Clear the entire queue?")) {
    try {
      await fetch("/queue/clear", { method: "POST" })
      showNotification("Queue cleared", "success", 2000)
    } catch (error) {
      console.error("Clear error:", error)
      showNotification("Failed to clear queue", "error")
    }
  }
}

// Progress tracking (main player only)
function updateProgress() {
  if (!isMainPlayer) return

  const audio = document.getElementById("audioPlayer")
  const progressFill = document.getElementById("progress-fill")
  const currentTimeEl = document.getElementById("current-time")

  if (audio && progressFill && currentTimeEl) {
    const progress = (audio.currentTime / audio.duration) * 100
    progressFill.style.width = `${progress}%`
    currentTimeEl.textContent = formatTime(audio.currentTime)
  }
}

function updateDuration() {
  if (!isMainPlayer) return

  const audio = document.getElementById("audioPlayer")
  const totalTimeEl = document.getElementById("total-time")

  if (audio && totalTimeEl) {
    totalTimeEl.textContent = formatTime(audio.duration)
  }
}

function startProgressSync() {
  if (!isMainPlayer) return

  stopProgressSync()
  progressInterval = setInterval(() => {
    const audio = document.getElementById("audioPlayer")
    if (audio && !audio.paused) {
      // Sync time with server every 2 seconds
      socket.emit("time_sync", {
        current_time: audio.currentTime,
        is_playing: !audio.paused,
      })
    }
  }, 2000)
}

function stopProgressSync() {
  if (progressInterval) {
    clearInterval(progressInterval)
    progressInterval = null
  }
}

function onSongEnded() {
  if (!isMainPlayer) return

  isPlaying = false
  stopProgressSync()
  updatePlayPauseButton()
  setTimeout(playNext, 1000) // Small delay before next song
}

// Update displays
function updateNowPlaying(song) {
  // Update main player display
  const titleEl = document.getElementById("current-title")
  const artistEl = document.getElementById("current-artist")
  const requesterEl = document.getElementById("current-requester")

  // Update remote display
  const remoteTitleEl = document.getElementById("remote-title")
  const remoteArtistEl = document.getElementById("remote-artist")
  const remoteRequesterEl = document.getElementById("remote-requester")

  if (song) {
    if (titleEl) titleEl.textContent = song.title
    if (artistEl) artistEl.textContent = song.artist
    if (requesterEl) requesterEl.textContent = `Requested by ${song.requestedBy}`

    if (remoteTitleEl) remoteTitleEl.textContent = song.title
    if (remoteArtistEl) remoteArtistEl.textContent = song.artist
    if (remoteRequesterEl) remoteRequesterEl.textContent = `Requested by ${song.requestedBy}`

    currentSong = song
  } else {
    const noSongText = isMainPlayer ? "No song playing" : "No song playing"
    const noArtistText = isMainPlayer ? "Add songs to get started" : "Waiting for music..."

    if (titleEl) titleEl.textContent = noSongText
    if (artistEl) artistEl.textContent = noArtistText
    if (requesterEl) requesterEl.textContent = ""

    if (remoteTitleEl) remoteTitleEl.textContent = noSongText
    if (remoteArtistEl) remoteArtistEl.textContent = noArtistText
    if (remoteRequesterEl) remoteRequesterEl.textContent = ""

    currentSong = null
  }
}

function updatePlayPauseButton() {
  const button = document.getElementById("playPauseButton")
  const remoteButton = document.getElementById("remote-play-pause")

  const text = isPlaying ? "⏸️ Pause" : "▶️ Play"

  if (button) button.textContent = text
  if (remoteButton) remoteButton.textContent = text
}

function updateUsersDisplay() {
  const userCount = document.getElementById("user-count")
  const userList = document.getElementById("user-list")

  if (userCount) {
    const text = isMainPlayer ? `${connectedUsers.length} team members online` : `${connectedUsers.length} online`
    userCount.textContent = text
  }

  if (userList) {
    userList.innerHTML = connectedUsers.map((user) => `<span class="user-badge">${htmlEscape(user)}</span>`).join("")
  }
}

function updateMainPlayerStatus(connected) {
  mainPlayerConnected = connected
  const statusEl = document.getElementById("main-player-status")
  const connectionEl = document.getElementById("connection-status")

  if (statusEl) {
    statusEl.textContent = connected ? "🟢 Main Player Online" : "🔴 Main Player Offline"
    statusEl.className = connected ? "status-connected" : "status-disconnected"
  }

  if (connectionEl && isMainPlayer) {
    connectionEl.textContent = "🟢 Connected as Main Player"
    connectionEl.className = "status-connected"
  }
}

function updateRemoteProgress(state) {
  const progressFill = document.getElementById("remote-progress-fill")
  const currentTimeEl = document.getElementById("remote-current-time")
  const totalTimeEl = document.getElementById("remote-total-time")

  if (progressFill && state.duration > 0) {
    const progress = (state.current_time / state.duration) * 100
    progressFill.style.width = `${progress}%`
  }

  if (currentTimeEl) currentTimeEl.textContent = formatTime(state.current_time)
  if (totalTimeEl) totalTimeEl.textContent = formatTime(state.duration)
}

// Remote control functions
async function remoteTogglePlayPause() {
  debugLog("Remote toggle play/pause called")
  try {
    await fetch("/player/toggle", { method: "POST" })
  } catch (error) {
    console.error("Remote play/pause error:", error)
    showNotification("Failed to toggle playback", "error")
  }
}

async function remoteChangeVolume(value) {
  const volumeValue = document.getElementById("remote-volume-value")
  if (volumeValue) volumeValue.textContent = `${value}%`

  try {
    await fetch("/player/volume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume: value / 100 }),
    })
  } catch (error) {
    console.error("Remote volume error:", error)
    showNotification("Failed to change volume", "error")
  }
}

// Play the next song with better error handling
async function playNext() {
  debugLog("playNext called", { isMainPlayer, queueLength: queue.length })

  if (isMainPlayer) {
    // Main player calls the API
    try {
      const res = await fetch("/play-next", { method: "POST" })
      const data = await res.json()

      debugLog("playNext response", data)

      if (data.error) {
        updateNowPlaying(null)
        showNotification(`Cannot play song: ${data.error}`, "error")
        return
      }

      if (data.message && data.message.includes("stopped")) {
        // No more songs, stop playback
        const audio = document.getElementById("audioPlayer")
        if (audio) {
          audio.pause()
          audio.src = ""
        }
        isPlaying = false
        stopProgressSync()
        updatePlayPauseButton()
        updateNowPlaying(null)
        showNotification("Queue is empty. Add more songs to continue.", "info")
        return
      }

      const audio = document.getElementById("audioPlayer")
      if (audio) {
        debugLog("Loading audio from:", data.url)
        audio.src = data.url

        audio.onerror = (e) => {
          console.error("Audio error:", e)
          showNotification("Failed to load audio. The stream may be unavailable.", "error")
        }

        try {
          await audio.play()
          isPlaying = true
          updatePlayPauseButton()
          startProgressSync()
          showNotification(`Now playing: ${data.title}`, "success", 3000)
        } catch (playError) {
          console.error("Error playing audio:", playError)
          showNotification("Failed to play audio. Please try again or try a different song.", "error")
        }
      }

      updateNowPlaying({
        title: data.title,
        artist: data.artist,
        requestedBy: data.requestedBy,
      })
    } catch (error) {
      console.error("Error playing next song:", error)
      showNotification("Failed to play next song. Please check your connection and try again.", "error")
    }
  } else {
    // Remote control sends command to server
    await remotePlayNext()
  }
}

// Add stop functionality
async function stopSong() {
  if (isMainPlayer) {
    // Main player stops audio directly
    const audio = document.getElementById("audioPlayer")
    if (audio) {
      audio.pause()
      audio.src = ""
    }
    isPlaying = false
    stopProgressSync()
    updatePlayPauseButton()
    updateNowPlaying(null)
    showNotification("Playback stopped", "info", 2000)
  }

  // Always send to server for sync
  try {
    await fetch("/player/stop", { method: "POST" })
  } catch (error) {
    console.error("Stop error:", error)
    showNotification("Failed to stop playback", "error")
  }
}

// Update remote control functions
async function remotePlayNext() {
  debugLog("remotePlayNext called")
  try {
    const res = await fetch("/play-next", { method: "POST" })
    const data = await res.json()

    debugLog("remotePlayNext response", data)

    if (data.error) {
      showNotification(`Cannot play next song: ${data.error}`, "error")
    }
    // Don't try to handle the response here - let the WebSocket handle it
  } catch (error) {
    console.error("Remote play next error:", error)
    showNotification("Failed to play next song. Please try again.", "error")
  }
}

async function remoteStop() {
  try {
    await fetch("/player/stop", { method: "POST" })
  } catch (error) {
    console.error("Remote stop error:", error)
    showNotification("Failed to stop playback", "error")
  }
}

// WebSocket connection - moved outside window.onload
socket.on("connect", () => {
  debugLog("Connected to server")
  showNotification("Connected to server", "success", 2000)
  if (currentUser) {
    socket.emit("join_room", { username: currentUser, is_main_player: isMainPlayer })
  }
})

socket.on("error", (data) => {
  showNotification(data.message, "error")
  if (isMainPlayer) {
    setTimeout(() => {
      window.location.href = "/"
    }, 3000)
  }
})

socket.on("queue_updated", (data) => {
  queue = data.queue || []
  connectedUsers = data.users || []
  updateQueueDisplay()
  updateUsersDisplay()
})

socket.on("now_playing", (data) => {
  debugLog("now_playing event received", data)
  if (data.song) {
    updateNowPlaying({
      title: data.song.title,
      artist: data.song.artist,
      requestedBy: data.song.requestedBy,
    })
  }
  if (data.playerState) {
    playerState = data.playerState
    isPlaying = playerState.is_playing
    updatePlayPauseButton()
    updateRemoteProgress(playerState)
  }
})

socket.on("player_control", (data) => {
  debugLog("player_control event received", data)

  if (!isMainPlayer) {
    debugLog("Ignoring player_control - not main player")
    return // Only main player responds to controls
  }

  const audio = document.getElementById("audioPlayer")

  switch (data.action) {
    case "toggle_play_pause":
      debugLog("Processing toggle_play_pause")
      if (audio && audio.src) {
        if (data.is_playing && audio.paused) {
          audio.play()
          startProgressSync()
        } else if (!data.is_playing && !audio.paused) {
          audio.pause()
          stopProgressSync()
        }
        isPlaying = data.is_playing
        updatePlayPauseButton()
      }
      break

    case "volume":
      debugLog("Processing volume change", data.volume)
      if (audio) {
        audio.volume = data.volume
        const volumeSlider = document.getElementById("volumeSlider")
        const volumeValue = document.getElementById("volumeValue")
        if (volumeSlider) volumeSlider.value = data.volume * 100
        if (volumeValue) volumeValue.textContent = `${Math.round(data.volume * 100)}%`
      }
      break

    case "play_new_song":
      debugLog("Processing play_new_song", data)
      if (audio) {
        // Stop current song first
        audio.pause()
        audio.src = ""

        debugLog("Loading new song from remote:", data.url)
        audio.src = data.url

        audio.onerror = (e) => {
          console.error("Audio error:", e)
          debugLog("Audio load error", e)
          showNotification("Failed to load audio. The stream may be unavailable.", "error")
        }

        // Use oncanplaythrough for better auto-play reliability
        audio.oncanplaythrough = () => {
          debugLog("Audio can play through, attempting to play")
          if (data.auto_play) {
            audio
              .play()
              .then(() => {
                debugLog("Audio playing successfully")
                isPlaying = true
                updatePlayPauseButton()
                startProgressSync()

                // Update the display
                updateNowPlaying({
                  title: data.title,
                  artist: data.artist,
                  requestedBy: data.requestedBy,
                })
                showNotification(`Now playing: ${data.title}`, "success", 3000)
              })
              .catch((playError) => {
                console.error("Error playing audio:", playError)
                debugLog("Audio play error", playError)
                showNotification("Failed to play audio. Please try again or try a different song.", "error")
              })
          } else {
            // Manual play - just update display
            updateNowPlaying({
              title: data.title,
              artist: data.artist,
              requestedBy: data.requestedBy,
            })
          }
        }

        // Fallback to onloadeddata if oncanplaythrough doesn't fire
        setTimeout(() => {
          if (audio.readyState >= 3 && data.auto_play && audio.paused) {
            debugLog("Fallback: trying to play after timeout")
            audio.play().catch(console.error)
          }
        }, 2000)
      }
      break

    case "stop":
      debugLog("Processing stop")
      if (audio) {
        audio.pause()
        audio.src = ""
      }
      isPlaying = false
      stopProgressSync()
      updatePlayPauseButton()
      updateNowPlaying(null)
      break
  }
})

socket.on("player_state_update", (data) => {
  debugLog("player_state_update received", data.playerState)
  playerState = data.playerState
  isPlaying = playerState.is_playing
  updatePlayPauseButton()
  updateRemoteProgress(playerState)

  // Update volume sliders
  const remoteVolumeSlider = document.getElementById("remote-volume-slider")
  const remoteVolumeValue = document.getElementById("remote-volume-value")

  if (remoteVolumeSlider) remoteVolumeSlider.value = playerState.volume * 100
  if (remoteVolumeValue) remoteVolumeValue.textContent = `${Math.round(playerState.volume * 100)}%`
})

socket.on("time_update", (data) => {
  if (!isMainPlayer) {
    // Only update remote displays
    playerState = data.playerState
    updateRemoteProgress(playerState)
  }
})

socket.on("main_player_status", (data) => {
  updateMainPlayerStatus(data.connected)
})

socket.on("disconnect", () => {
  showNotification("Disconnected from server. Trying to reconnect...", "warning")
})

socket.on("reconnect", () => {
  showNotification("Reconnected to server", "success", 2000)
})

// Logout function
function logout() {
  if (confirm("Are you sure you want to logout?")) {
    // Clear stored username
    currentUser = ""
    localStorage.removeItem("musicPlayerUsername")

    // Disconnect from socket
    socket.disconnect()

    // Show username input again
    const usernameInput = document.getElementById("username")
    const logoutBtn = document.getElementById("logout-btn")

    if (usernameInput) {
      usernameInput.style.display = "inline-block"
      usernameInput.value = ""
      usernameInput.nextElementSibling.style.display = "inline-block"
    }

    if (logoutBtn) {
      logoutBtn.style.display = "none"
    }

    // Reconnect socket for new session
    setTimeout(() => {
      socket.connect()
    }, 500)

    showNotification("Logged out successfully", "info", 3000)
  }
}

// Initialize when page loads
window.onload = () => {
  debugLog("Page loaded")

  // Set username input if available
  const usernameInput = document.getElementById("username")
  const logoutBtn = document.getElementById("logout-btn")

  if (usernameInput && currentUser) {
    usernameInput.value = currentUser
    usernameInput.style.display = "none"
    usernameInput.nextElementSibling.style.display = "none"
    if (logoutBtn) {
      logoutBtn.style.display = "inline-block"
    }
  } else if (logoutBtn) {
    logoutBtn.style.display = "none"
  }

  // Auto-join if user is already set
  if (currentUser) {
    socket.emit("join_room", { username: currentUser, is_main_player: isMainPlayer })
  }

  // Load initial queue
  fetch("/api/queue")
    .then((res) => res.json())
    .then((data) => {
      queue = data
      updateQueueDisplay()
    })
    .catch(console.error)

  // Load current song if any
  fetch("/current")
    .then((res) => res.json())
    .then((data) => {
      if (data.song) {
        updateNowPlaying({
          title: data.song.title,
          artist: data.song.artist,
          requestedBy: data.song.requestedBy,
        })
      }
      if (data.playerState) {
        playerState = data.playerState
        isPlaying = playerState.is_playing
        updatePlayPauseButton()
        updateRemoteProgress(playerState)

        if (isMainPlayer) {
          const audio = document.getElementById("audioPlayer")
          const volumeSlider = document.getElementById("volumeSlider")
          const volumeValue = document.getElementById("volumeValue")

          if (audio) audio.volume = playerState.volume
          if (volumeSlider) volumeSlider.value = playerState.volume * 100
          if (volumeValue) volumeValue.textContent = `${Math.round(playerState.volume * 100)}%`
        }
      }

      updateMainPlayerStatus(data.mainPlayerConnected)
    })
    .catch(console.error)
}
