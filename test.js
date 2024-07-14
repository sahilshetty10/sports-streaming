const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const sqlite3 = require("sqlite3");
const moment = require("moment-timezone");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Static files middleware
app.use(express.static("public"));

const DB_UPDATE_INTERVAL = 60 * 60 * 1000; // 1 hour
const M3U8_UPDATE_INTERVAL = 3000; // 3 seconds
const FILE_CLEANUP_INTERVAL = 60000; // 1 minute
let streamIds = [];

// Initialize SQLite database
const db = new sqlite3.Database("test.db", (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link TEXT,
      title TEXT,
      date DATETIME,
      image TEXT,
      playlist TEXT DEFAULT NULL
    )
  `);
});

// function to search for matches. This function will be called every 1 hour
async function updateMatches() {
  try {
    const response = await axios.get("https://1stream.eu");
    const $ = cheerio.load(response.data);

    const stmt = db.prepare(
      "INSERT INTO matches (link, title, date, image) VALUES (?, ?, ?, ?)"
    );

    $(".btn.btn-default.btn-block").each((element) => {
      const link = $(element).attr("href");
      const title = $(element).find(".media-heading").text().trim();
      const date = $(element).find("p").text().trim();
      const image = $(element).find("img").attr("src");

      const eventDate = moment.tz(date, "ddd DD MMM YYYY HH:mm A z", "EST");

      if (eventDate.isValid()) {
        stmt.run(link, title, eventDate.format("YYYY-MM-DD HH:mm:ss"), image);
      }
      stmt.finalize();
    });
  } catch (error) {
    console.error("Error updating matches", error.message);
  }
}

updateMatches();
setInterval(updateMatches, DB_UPDATE_INTERVAL);

// function to get matches where playlist is not null
async function getUpcomingMatches() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM matches WHERE playlist IS NOT NULL", (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// function to generate m3u8 playlist for each match
async function generatePlaylists() {
  // get all matches from db for columns link and id
  let matches = db.all("SELECT link, id FROM matches WHERE playlist IS NULL");
  console.log(matches);
  matches.forEach(async (match) => {
    await generateM3U8(match.link, match.id);
  });
}

setInterval(generatePlaylists, M3U8_UPDATE_INTERVAL);

// function to generate m3u8 playlist
async function generateM3U8(link, id) {
  try {
    let response = await axios.get(link);
    const secretKeyRegex = /window\.atob\("([^"]+)"\)/;
    const secretKeyMatch = response.data.match(secretKeyRegex);
    if (!secretKeyMatch) {
      return;
    }
    const encodedKey = secretKeyMatch[1];
    const decodedKey = Buffer.from(encodedKey, "base64").toString("ascii");
    const { data, chunks } = await getChunks(decodedKey);
    const playlist_path = await saveChunksAndGeneratePlaylist(data, chunks, id);
    if (playlist_path) {
      db.run("UPDATE matches SET playlist = ? WHERE id = ?", [
        playlist_path,
        id,
      ]);
    }
  } catch (error) {
    throw Error("Error generating m3u8 playlist", error.message);
  }
}

// function to get chunks
async function getChunks(decodedKey) {
  // 3 retries to get the chunks
  for (let i = 0; i < 3; i++) {
    try {
      const response = await axios.get(decodedKey);
      let m3u8Content = response.data;
      const chunks = m3u8Content.match(/https?:\/\/[^\s]+/g);
      if (chunks) {
        return { response, chunks };
      }
    } catch (error) {
      throw Error("Error getting chunks", error.message);
    }
  }
}

// function to save chunks and generate playlist
async function saveChunksAndGeneratePlaylist(data, chunks, id) {
  const base_path = path.join(__dirname, `public/${id}`);
  if (!fs.existsSync(base_path)) {
    fs.mkdirSync(base_path, { recursive: true });
  }
  try {
    chunks.forEach(async (chunk) => {
      let response = await axios.get(chunk, { responseType: "stream" });
      let filepath = path.join(base_path, `chunk-${Date.now()}.ts`);
      response.data.pipe(fs.createWriteStream(path.join(base_path, filepath)));
      await new Promise((resolve, reject) => {
        response.data.on("end", resolve);
        response.data.on("error", reject);
      });
      data.replace(chunk, filepath);
    });
    await fs.promises.writeFile(path.join(base_path, "playlist.m3u8"), data);
    return path.join(base_path, "playlist.m3u8");
  } catch (error) {
    throw Error("Error saving chunks", error.message);
  }
}
