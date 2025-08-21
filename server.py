import yt_dlp
import os
import time
import threading
import logging
import uuid
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS
from ytmusicapi import YTMusic
from flask_socketio import SocketIO, emit, join_room, leave_room
import requests
from datetime import datetime

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

socketio = SocketIO(app, cors_allowed_origins="*")

ytmusic = YTMusic()
queue = []  # Global queue for songs
stream_url_cache = {}  # Cache for stream URLs
connected_users = {}  # Track connected users
current_song = None
song_start_time = None
player_state = {
  "is_playing": False,
  "volume": 0.8,
  "current_time": 0,
  "duration": 0
}
main_player_sid = None  # Track the main player session

def get_stream_url(video_id):
  """Get direct streaming URL for a song/video."""
  if video_id in stream_url_cache:
      logger.info(f"Using cached stream URL for {video_id}")
      return stream_url_cache[video_id]
  
  # yt_dlp can handle both music.youtube.com and www.youtube.com URLs
  url = f"https://www.youtube.com/watch?v={video_id}" 
  ydl_opts = {
      "format": "bestaudio/best",
      "quiet": True,
      "geo_bypass": True,
      "noplaylist": True,
      "extractaudio": True,
      "cookiefile": "./cookie.txt",
      "retries": 3,
      "socket_timeout": 30,
  }
  
  try:
      logger.info(f"Fetching stream URL for video ID: {video_id}")
      with yt_dlp.YoutubeDL(ydl_opts) as ydl:
          info = ydl.extract_info(url, download=False)
          stream_url = info.get("url")
          duration = info.get("duration", 0)
          
          if stream_url:
              stream_url_cache[video_id] = {"url": stream_url, "duration": duration}
              logger.info(f"Successfully got stream URL for {video_id}")
              return {"url": stream_url, "duration": duration}
          else:
              logger.error(f"No stream URL found for {video_id}")
              return None
              
  except Exception as e:
      logger.error(f"Error fetching stream URL for {video_id}: {e}")
      return None

@app.route("/api/search", methods=["GET"])
def search():
  query = request.args.get("query")
  search_type = request.args.get("type", "songs") # Default to songs
  
  if not query:
      return jsonify({"error": "Missing query"}), 400
  
  try:
      logger.info(f"Searching for: {query} with type: {search_type}")
      
      if search_type == "songs":
          results = ytmusic.search(query, filter="songs", limit=15)
      elif search_type == "videos":
          results = ytmusic.search(query, filter="videos", limit=15)
      else:
          return jsonify({"error": "Invalid search type. Use 'songs' or 'videos'."}), 400
          
      formatted_results = []
      for result in results:
          if search_type == "songs":
              formatted_result = {
                  "id": str(uuid.uuid4()),
                  "title": result.get("title", "Unknown Title"),
                  "artist": result.get("artists", [{"name": "Unknown Artist"}])[0]["name"] if result.get("artists") else "Unknown Artist",
                  "duration": result.get("duration", {}).get("text", "Unknown") if isinstance(result.get("duration"), dict) else str(result.get("duration", "Unknown")),
                  "thumbnail": result.get("thumbnails", [{"url": "/placeholder.svg?height=60&width=60"}])[0]["url"] if result.get("thumbnails") else "/placeholder.svg?height=60&width=60",
                  "videoId": result.get("videoId", ""),
              }
          elif search_type == "videos":
              formatted_result = {
                  "id": str(uuid.uuid4()),
                  "title": result.get("title", "Unknown Title"),
                  "artist": result.get("artists", [{"name": result.get("channel", {}).get("name", "Unknown Artist")}])[0]["name"], # Use channel name for videos
                  "duration": result.get("duration", "Unknown"), # Duration is often a string for videos
                  "thumbnail": result.get("thumbnails", [{"url": "/placeholder.svg?height=60&width=60"}])[0]["url"] if result.get("thumbnails") else "/placeholder.svg?height=60&width=60",
                  "videoId": result.get("videoId", ""),
              }
          formatted_results.append(formatted_result)
              
      logger.info(f"Found {len(formatted_results)} results for: {query} ({search_type})")
      return jsonify(formatted_results)
      
  except Exception as e:
      logger.error(f"Search error for '{query}' (type: {search_type}): {e}")
      return jsonify({"error": "Search failed"}), 500

@app.route("/api/queue", methods=["POST", "GET", "DELETE"])
def handle_queue():
  global queue, current_song, player_state, song_start_time
  
  if request.method == "GET":
      return jsonify(queue)
  
  elif request.method == "POST":
      data = request.json
      video_id = data.get("videoId")
      title = data.get("title")
      artist = data.get("artist") 
      duration = data.get("duration")
      thumbnail = data.get("thumbnail")
      requested_by = data.get("requestedBy", "Anonymous")

      if not video_id:
          return jsonify({"error": "Invalid data"}), 400

      # Check if song is already in the queue
      if any(song["videoId"] == video_id for song in queue):
          return jsonify({"message": "Song already in queue"}), 200

      # Pre-load the stream URL before adding to queue
      logger.info(f"Pre-loading stream for: {title}")
      stream_data = get_stream_url(video_id)
      
      if not stream_data:
          return jsonify({"error": "Failed to load song. Please try another."}), 500

      song_data = {
          "id": str(uuid.uuid4()),
          "videoId": video_id,
          "title": title,
          "artist": artist,
          "thumbnail": thumbnail,
          "duration": duration,
          "requestedBy": requested_by,
          "addedAt": datetime.now().isoformat(),
          "votes": 0,
          "streamReady": True,
          "streamUrl": f"/stream/{video_id}",
          "durationSeconds": stream_data["duration"]
      }
      
      queue.append(song_data)
      logger.info(f"Added to queue: {title} by {requested_by}")

      # Check if we should auto-start playing
      should_auto_play = (current_song is None and not player_state["is_playing"] and main_player_sid is not None)
      
      if should_auto_play:
          logger.info("Auto-starting playback since no song is currently playing")
          # Use a small delay to ensure the queue update is processed first
          def auto_play():
              time.sleep(0.5)  # Small delay
              try:
                  # Call play_next_internal to start the first song
                  result = play_next_internal()
                  if result.get("error"):
                      logger.error(f"Auto-play failed: {result['error']}")
              except Exception as e:
                  logger.error(f"Error in auto-play: {e}")
          
          # Run auto-play in a separate thread to avoid blocking
          threading.Thread(target=auto_play, daemon=True).start()

      # Notify all clients about queue update
      socketio.emit("queue_updated", {"queue": queue, "users": list(connected_users.values())})
      
      response_message = "Added to queue and will start playing" if should_auto_play else "Added to queue"
      return jsonify({"message": response_message, "auto_started": should_auto_play})
  
  elif request.method == "DELETE":
      song_id = request.args.get("id")
      if not song_id:
          return jsonify({"error": "Missing song ID"}), 400

      # Remove from cache if exists
      for song in queue:
          if song["id"] == song_id:
              video_id = song["videoId"]
              if video_id in stream_url_cache:
                  del stream_url_cache[video_id]
              break

      queue = [song for song in queue if song["id"] != song_id]
      socketio.emit("queue_updated", {"queue": queue, "users": list(connected_users.values())})
      return jsonify({"message": "Removed from queue"})

# Add the missing /queue route (legacy support)
@app.route("/queue", methods=["GET"])
def get_queue():
  return jsonify(queue)

@app.route("/stream/<video_id>")
def stream(video_id):
  """Proxy the stream URL to the client."""
  try:
      stream_data = get_stream_url(video_id)
      
      if not stream_data:
          logger.error(f"No stream URL available for {video_id}")
          return jsonify({"error": "Failed to get stream URL"}), 500

      stream_url = stream_data["url"]
      logger.info(f"Streaming {video_id}")

      def generate():
          try:
              headers = {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
              }
              with requests.get(stream_url, stream=True, timeout=30, headers=headers) as r:
                  r.raise_for_status()
                  for chunk in r.iter_content(chunk_size=8192):
                      if chunk:
                          yield chunk
          except requests.RequestException as e:
              logger.error(f"Error streaming audio for {video_id}: {e}")
              return

      return Response(stream_with_context(generate()), 
                     content_type="audio/mpeg",
                     headers={
                         'Accept-Ranges': 'bytes',
                         'Cache-Control': 'no-cache'
                     })
                     
  except Exception as e:
      logger.error(f"Stream error for {video_id}: {e}")
      return jsonify({"error": "Streaming failed"}), 500

def play_next_internal():
  """Internal function to play next song - can be called from API or auto-play"""
  global queue, current_song, song_start_time, player_state
  
  logger.info(f"Play next internal - Main player SID: {main_player_sid}")
  logger.info(f"Queue length: {len(queue)}")
  
  if not main_player_sid:
      logger.error("No main player connected")
      return {"error": "No main player connected"}

  # If no songs in queue, stop current song
  if not queue:
      current_song = None
      song_start_time = None
      player_state["is_playing"] = False
      player_state["current_time"] = 0
      player_state["duration"] = 0
      
      # Tell main player to stop
      logger.info("No songs in queue, sending stop command")
      socketio.emit("player_control", {"action": "stop"}, to=main_player_sid)
      
      # Notify all clients
      socketio.emit("now_playing", {
          "song": None, 
          "startTime": None,
          "playerState": player_state
      })
      socketio.emit("player_state_update", {"playerState": player_state})
      
      return {"message": "No more songs in queue, playback stopped"}

  song = queue[0]
  video_id = song["videoId"]
  
  logger.info(f"Playing next: {song['title']} - Video ID: {video_id}")
  
  # Remove from queue
  queue.pop(0)
  current_song = song
  song_start_time = time.time()
  player_state["is_playing"] = True
  player_state["current_time"] = 0
  player_state["duration"] = song.get("durationSeconds", 0)
  
  # Send the new song to main player to actually load and play
  play_command = {
      "action": "play_new_song",
      "url": song["streamUrl"],
      "title": song["title"],
      "artist": song["artist"],
      "requestedBy": song["requestedBy"],
      "videoId": video_id,
      "auto_play": True  # Flag to indicate this should auto-play
  }
  
  logger.info(f"Sending play command to main player {main_player_sid}: {play_command}")
  
  # Send directly to the main player session
  socketio.emit("player_control", play_command, to=main_player_sid)
  
  # Also broadcast to all clients for UI updates
  socketio.emit("queue_updated", {"queue": queue, "users": list(connected_users.values())})
  socketio.emit("now_playing", {
      "song": current_song, 
      "startTime": song_start_time,
      "playerState": player_state
  })
  socketio.emit("player_state_update", {"playerState": player_state})

  return {
      "title": song["title"],
      "url": song["streamUrl"],
      "artist": song["artist"],
      "requestedBy": song["requestedBy"],
      "duration": song.get("durationSeconds", 0)
  }

@app.route("/play-next", methods=["POST"])
def play_next():
  result = play_next_internal()
  if "error" in result:
      return jsonify(result), 400
  return jsonify(result)

@app.route("/player/stop", methods=["POST"])
def stop_song():
  global current_song, song_start_time, player_state
  
  if not main_player_sid:
      return jsonify({"error": "No main player connected"}), 400
  
  # Stop current song
  current_song = None
  song_start_time = None
  player_state["is_playing"] = False
  player_state["current_time"] = 0
  player_state["duration"] = 0
  
  # Send stop command to main player
  socketio.emit("player_control", {"action": "stop"}, to=main_player_sid)
  
  # Send state update to all clients (including remotes)
  socketio.emit("now_playing", {
      "song": None, 
      "startTime": None,
      "playerState": player_state
  })
  socketio.emit("player_state_update", {"playerState": player_state})
  
  return jsonify({"message": "Playback stopped"})

@app.route("/player/toggle", methods=["POST"])
def toggle_play_pause():
  global player_state
  
  if not main_player_sid:
      return jsonify({"error": "No main player connected"}), 400
      
  player_state["is_playing"] = not player_state["is_playing"]
  
  # Send control to main player
  socketio.emit("player_control", {
      "action": "toggle_play_pause", 
      "is_playing": player_state["is_playing"]
  }, to=main_player_sid)
  
  # Send state update to ALL clients (including remotes)
  socketio.emit("player_state_update", {"playerState": player_state})
  
  return jsonify({"is_playing": player_state["is_playing"]})

@app.route("/player/volume", methods=["POST"])
def set_volume():
  global player_state
  data = request.json
  volume = data.get("volume", 0.8)
  volume = max(0, min(1, volume))
  player_state["volume"] = volume
  
  if main_player_sid:
      socketio.emit("player_control", {"action": "volume", "volume": volume}, to=main_player_sid)
  
  # Send to all clients
  socketio.emit("player_state_update", {"playerState": player_state})
  return jsonify({"volume": volume})

@app.route("/current", methods=["GET"])
def get_current_song():
  return jsonify({
      "song": current_song,
      "startTime": song_start_time,
      "currentTime": time.time() - song_start_time if song_start_time else 0,
      "playerState": player_state,
      "mainPlayerConnected": main_player_sid is not None,
      "queue": queue
  })

@app.route("/queue/clear", methods=["POST"])
def clear_queue():
  global queue
  queue = []
  socketio.emit("queue_updated", {"queue": queue, "users": list(connected_users.values())})
  return jsonify({"message": "Queue cleared"})

@app.route("/queue/shuffle", methods=["POST"])
def shuffle_queue():
  global queue
  import random
  if len(queue) > 1:
      random.shuffle(queue)
      socketio.emit("queue_updated", {"queue": queue, "users": list(connected_users.values())})
  return jsonify({"message": "Queue shuffled"})

# WebSocket events
@socketio.on('connect')
def handle_connect():
  logger.info(f'Client connected: {request.sid}')
  emit('connected', {'status': 'Connected to server'})

@socketio.on('disconnect')
def handle_disconnect():
  global main_player_sid
  logger.info(f'Client disconnected: {request.sid}')
  
  if request.sid in connected_users:
      del connected_users[request.sid]
  
  # Check if main player disconnected
  if request.sid == main_player_sid:
      main_player_sid = None
      socketio.emit("main_player_status", {"connected": False})
      logger.info("Main player disconnected")
  
  socketio.emit("users_updated", {"users": list(connected_users.values())})

@socketio.on('join_room')
def handle_join_room(data):
  global main_player_sid
  
  username = data.get('username', f'User_{request.sid[:6]}')
  is_main_player = data.get('is_main_player', False)
  
  logger.info(f'Join room request: {username}, is_main_player: {is_main_player}, SID: {request.sid}')
  
  if is_main_player:
      if main_player_sid is not None and main_player_sid != request.sid:
          emit('error', {'message': 'Main player already connected. Only one player allowed.'})
          return
      
      main_player_sid = request.sid
      join_room("main_player")
      socketio.emit("main_player_status", {"connected": True})
      logger.info(f"Main player connected: {username} with SID: {main_player_sid}")
  
  connected_users[request.sid] = username
  logger.info(f'User joined: {username} (Main player: {is_main_player})')
  
  emit('user_joined', {'username': username}, broadcast=True)
  socketio.emit("users_updated", {"users": list(connected_users.values())})
  
  # Send current state to new user
  emit('queue_updated', {"queue": queue, "users": list(connected_users.values())})
  if current_song:
      emit('now_playing', {
          "song": current_song, 
          "startTime": song_start_time,
          "playerState": player_state
      })
  emit('player_state_update', {"playerState": player_state})
  emit('main_player_status', {"connected": main_player_sid is not None})

@socketio.on('time_sync')
def handle_time_sync(data):
  """Handle time synchronization from main player"""
  global player_state
  if request.sid == main_player_sid:
      player_state["current_time"] = data.get("current_time", 0)
      player_state["is_playing"] = data.get("is_playing", False)
      
      # Broadcast to all clients except sender
      emit("time_update", {"playerState": player_state}, broadcast=True, skip_sid=request.sid)

@socketio.on('debug_message')
def handle_debug_message(data):
  """Handle debug messages from clients"""
  logger.info(f'Debug message from {request.sid}: {data}')

# Static file routes
@app.route("/")
def index():
  return send_from_directory('.', 'index.html')

@app.route("/player")
def player():
  return send_from_directory('.', 'player.html')

@app.route("/styles.css")
def css():
  return send_from_directory('.', 'styles.css')

@app.route("/script.js")
def js():
  return send_from_directory('.', 'script.js')

@app.route("/placeholder.svg")
def placeholder():
  width = request.args.get('width', '60')
  height = request.args.get('height', '60')
  query = request.args.get('query', 'music thumbnail') # Added query for better placeholder generation
  svg_content = f'''<svg width="{width}" height="{height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#333"/>
      <text x="50%" y="50%" font-family="Arial" font-size="12" fill="white" text-anchor="middle" dy=".3em">🎵</text>
  </svg>'''
  return Response(svg_content, mimetype='image/svg+xml')

if __name__ == "__main__":
  print("Starting Team Music Player...")
  print("🎵 Team interface: http://localhost:5001")
  print("🎮 Main player: http://localhost:5001/player")
  
  socketio.run(app, host="0.0.0.0", port=5001, debug=True, allow_unsafe_werkzeug=True)
