const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs").promises;
const sqlite3 = require("sqlite3").verbose();
const moment = require("moment-timezone");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize SQLite database
const db = new sqlite3.Database("events.db");

// Create table for matches
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link TEXT NOT NULL,
      title TEXT,
      date TEXT,
      image TEXT
    )
  `);
});

// Middleware to fetch and update matches every minute
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

      // Parse date string using moment.js to compare with current time
      const eventDate = moment.tz(date, "ddd DD MMM YYYY HH:mm A z", "EST");

      // Check if the event date is upcoming (within the next 1 hour)
      if (
        eventDate.isValid() &&
        eventDate.isSameOrAfter(moment().subtract(1, "hour"))
      ) {
        events.push({
          link,
          title,
          date: date,
          image,
        });
      }
    });

    // Clear existing data in the table
    db.run("DELETE FROM matches");

    // Insert new matches into the database
    const stmt = db.prepare(
      "INSERT INTO matches (link, title, date, image) VALUES (?, ?, ?, ?)"
    );
    events.forEach((event) => {
      stmt.run(event.link, event.title, event.date, event.image);
    });
    stmt.finalize();

    console.log("Data fetched and stored successfully:", events);
  } catch (error) {
    console.error("Error fetching data:", error);
  }
};

// Fetch and store matches every 1 minute
setInterval(fetchAndStoreMatches, 16000);

// Express route to fetch all upcoming matches
app.get("/", (req, res) => {
  const now = moment();
  db.all(
    "SELECT * FROM matches WHERE date > ? ORDER BY date",
    [now.format("YYYY-MM-DD HH:mm:ss")],
    (err, rows) => {
      if (err) {
        console.error("Database error:", err);
        res.status(500).send("Database error");
      } else {
        res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Upcoming Matches</title>
        </head>
        <body>
          <h1>Upcoming Matches</h1>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Date</th>
                <th>Watch</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map(
                  (row) => `
                <tr>
                  <td>${row.title}</td>
                  <td>${row.date}</td>
                  <td><a href="/watch/${row.id}">Watch</a></td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </body>
        </html>
      `);
      }
    }
  );
});

// Express route to watch a specific match
app.get("/watch/:id", async (req, res) => {
  const id = req.params.id;

  db.get("SELECT * FROM matches WHERE id = ?", [id], async (err, row) => {
    if (err) {
      console.error("Database error:", err);
      res.status(500).send("Database error");
    } else if (!row) {
      res.status(404).send("Match not found");
    } else {
      try {
        const response = await axios.get(row.link);
        const htmlData = response.data;

        // Extract secret key using regex
        const secretKeyRegex = /window\.atob\("([^"]+)"\)/;
        const secretKeyMatch = htmlData.match(secretKeyRegex);

        // Decode the secret key
        const encodedKey = secretKeyMatch[1];
        const decodedKey = Buffer.from(encodedKey, "base64").toString("ascii");

        // Use the decoded key to fetch m3u8 file
        const m3u8Response = await axios.get(decodedKey);
        const m3u8Data = m3u8Response.data;

        // Process m3u8 file to download .ts files and modify it
        const modifiedM3U8 = await processM3U8(m3u8Data);

        // Save modified m3u8 data to a file
        const m3u8FileName = `${id}_playlist.m3u8`;
        await fs.writeFile(`public/${m3u8FileName}`, modifiedM3U8);

        // Respond with HTML containing Clappr player
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>Watch Match</title>
              <script
                type="text/javascript"
                src="https://cdn.jsdelivr.net/npm/clappr@latest/dist/clappr.min.js"
              ></script>
            </head>
            <body>
              <div id="player"></div>
              <script>
                var player = new Clappr.Player({
                  source: "/public/${m3u8FileName}", // Adjust the path as necessary
                  parentId: "#player",
                });
              </script>
            </body>
            </html>
          `);
      } catch (error) {
        console.error("Error fetching and processing data:", error);
        res.status(500).send("Error fetching and processing data");
      }
    }
  });
});

// Function to extract .ts files from m3u8 playlist
async function processM3U8(m3u8Data) {
  // Extract .ts file URLs from m3u8 playlist
  const tsFiles = m3u8Data.match(/https?:\/\/[^\s]+/g) || [];

  // Process each .ts file sequentially
  for (let i = 0; i < tsFiles.length; i++) {
    const tsFileUrl = tsFiles[i];
    const fileName = `public/file${i}.ts`;

    try {
      // Download .ts file
      const response = await axios.get(tsFileUrl, {
        responseType: "arraybuffer",
        Headers: {
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br, zstd",
          Origin: "null",
          Referer: "https://1stream.eu/",
        },
      });

      // Save downloaded file
      await fs.writeFile(fileName, response.data);

      // Modify m3u8Data to use local file path
      m3u8Data = m3u8Data.replace(tsFileUrl, fileName);
    } catch (error) {
      console.error(`Failed to process ${tsFileUrl}`, error);
      // Handle download errors if needed
    }
  }

  return m3u8Data;
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
