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
const db = new sqlite3.Database("events.db", (err) => {
  if (err) {
    console.error("Error opening database", err.message);
  }
});

// Create table for matches if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link TEXT,
      title TEXT,
      date DATETIME,
      image TEXT
    )
  `);
});

// Endpoint to get all matches
app.get("/api/matches", async (req, res) => {
  try {
    const matches = await getUpcomingMatches();
    res.json(matches);
  } catch (error) {
    console.error(error);
    res.status(500).send("An error occurred. Please try again later.");
  }
});

// Endpoint to get m3u8 playlist by match ID
app.get("/api/watch/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // Retrieve link by ID
    const link = await getLinkById(id);

    // Fetch m3u8 link from retrieved link
    const m3u8Link = await fetchM3u8Link(link);

    // Create playlist from m3u8 link
    const playlist = await createPlaylist(m3u8Link, id);

    // Store stream ID and link for future updates
    streamIds.push({ id, link: m3u8Link });

    // Send playlist URL in response
    res.send({ src: playlist });
  } catch (error) {
    // Log the error for debugging purposes
    console.error(
      `Error occurred while processing watch request for match ${req.params.id}:`,
      error
    );

    // Determine error type and send appropriate response
    if (error.message === "Match not found") {
      res.status(404).send("Match not found. Please check the match ID.");
    } else if (error.message === "Secret key not found in the response") {
      res.status(500).send("Error fetching m3u8 link: Secret key not found.");
    } else if (error.message === "No URLs found in the m3u8 content") {
      res
        .status(500)
        .send("Error creating playlist: No valid URLs found in m3u8 content.");
    } else {
      res.status(500).send("An error occurred. Please try again later.");
    }
  }
});

// Fetch and store matches from the website
const fetchAndStoreMatches = async () => {
  try {
    const response = await axios.get("https://1stream.eu");
    const $ = cheerio.load(response.data);

    const events = [];
    $(".btn.btn-default.btn-block").each((index, element) => {
      const link = $(element).attr("href");
      const title = $(element).find(".media-heading").text().trim();
      const date = $(element).find("p").text().trim();
      const image = $(element).find("img").attr("src");

      const eventDate = moment.tz(date, "ddd DD MMM YYYY HH:mm A z", "EST");

      if (eventDate.isValid()) {
        events.push({
          link,
          title,
          date: eventDate.format("YYYY-MM-DD HH:mm:ss"),
          image,
        });
      }
    });

    db.run("DELETE FROM matches");

    const stmt = db.prepare(
      "INSERT INTO matches (link, title, date, image) VALUES (?, ?, ?, ?)"
    );
    events.forEach((event) => {
      stmt.run(event.link, event.title, event.date, event.image);
    });
    stmt.finalize();
  } catch (error) {
    console.error("Error fetching and storing matches", error.message);
  }
};

// Query matches from the database within the time range
const getUpcomingMatches = () => {
  return new Promise((resolve, reject) => {
    const now = moment().format("YYYY-MM-DD HH:mm:ss");
    const fiveHoursAgo = moment()
      .subtract(5, "hours")
      .format("YYYY-MM-DD HH:mm:ss");
    const fiveHoursLater = moment()
      .add(5, "hours")
      .format("YYYY-MM-DD HH:mm:ss");

    db.all(
      // "SELECT * FROM matches",
      "SELECT * FROM matches WHERE date BETWEEN ? AND ?",
      [fiveHoursAgo, fiveHoursLater],
      (error, rows) => {
        if (error) {
          reject(error);
        } else {
          resolve(rows);
        }
      }
    );
  });
};

// Query link from the database by match ID
const getLinkById = (id) => {
  return new Promise((resolve, reject) => {
    db.get("SELECT link FROM matches WHERE id = ?", [id], (error, row) => {
      if (error) {
        reject(error);
      } else if (row) {
        resolve(row.link);
      } else {
        reject(new Error("Match not found"));
      }
    });
  });
};

// Get m3u8 link from the given link
const fetchM3u8Link = async (link) => {
  try {
    const response = await axios.get(link);
    const secretKeyRegex = /window\.atob\("([^"]+)"\)/;
    const secretKeyMatch = response.data.match(secretKeyRegex);

    if (secretKeyMatch) {
      const encodedKey = secretKeyMatch[1];
      const decodedKey = Buffer.from(encodedKey, "base64").toString("ascii");
      return decodedKey;
    } else {
      throw new Error("Secret key not found in the response");
    }
  } catch (error) {
    console.error("Error getting m3u8 link", error.message);
    throw error;
  }
};

// Get playlist from the m3u8 link
const createPlaylist = async (m3u8Link, id) => {
  try {
    const response = await axios.get(m3u8Link);
    let m3u8Content = response.data;
    const urls = m3u8Content.match(/https?:\/\/[^\s]+/g);

    if (!urls) {
      throw new Error("No URLs found in the m3u8 content");
    }

    const directory = path.join(__dirname, `public/${id}`);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const timestamp = Date.now();
      const fileName = `chunk-${timestamp}_${i}.ts`; // Changed filename format
      const filePath = path.join(directory, fileName);

      try {
        const response = await axios({
          method: "get",
          url: url,
          responseType: "stream",
          headers: {
            Accept: "*/*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            Origin: "null",
            Referer: "https://1stream.eu/",
          },
        });

        response.data.pipe(fs.createWriteStream(filePath));
        await new Promise((resolve, reject) => {
          response.data.on("end", resolve);
          response.data.on("error", reject);
        });

        m3u8Content = m3u8Content.replace(url, fileName);
      } catch (error) {
        console.error(`Failed to download ${url}`, error.message);
      }
    }

    const playlistPath = path.join(directory, "playlist.m3u8");
    await fs.promises.writeFile(playlistPath, m3u8Content);
    return `/${id}/playlist.m3u8`;
  } catch (error) {
    console.error("Error creating playlist", error.message);
    throw error;
  }
};

// Fetch and store matches every 1 hour
setInterval(fetchAndStoreMatches, DB_UPDATE_INTERVAL);

// Fetch and store m3u8 playlist every 3 seconds
const updateM3u8Playlists = async () => {
  for (const { id, link } of streamIds) {
    try {
      const playlist = await createPlaylist(link, id);
      if (playlist) {
        console.log(`Playlist updated for match ${id}`);
      }
    } catch (error) {
      console.error(`Error updating playlist for match ${id}`, error.message);
    }
  }
};
setInterval(updateM3u8Playlists, M3U8_UPDATE_INTERVAL);

// Delete files older than 1 minute
const deleteOldFiles = async () => {
  try {
    const directories = await fs.promises.readdir("public");
    for (const dir of directories) {
      const files = await fs.promises.readdir(path.join("public", dir));
      for (const file of files) {
        const filePath = path.join("public", dir, file);
        const stats = await fs.promises.stat(filePath);

        if (stats.isFile() && file.endsWith(".ts")) {
          if (Date.now() - stats.mtimeMs > FILE_CLEANUP_INTERVAL) {
            await fs.promises.unlink(filePath);
            console.log(`Deleted file: ${filePath}`);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error deleting old files", error.message);
  }
};
setInterval(deleteOldFiles, FILE_CLEANUP_INTERVAL);

// Serve the main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Serve the watch page
app.get("/watch/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "watch.html"));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Initial fetch of matches
fetchAndStoreMatches();
