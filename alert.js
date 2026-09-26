"use strict";

const axios = require("axios");
const cheerio = require("cheerio");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TARGET_URL =
  process.env.TARGET_URL || "https://dhakatuitionbd.com/bm/";

const STATE_PATH = path.join(
  __dirname,
  process.env.STATE_FILE || "sent_updates.json"
);

// Send currently-existing matching listings when state file is brand new.
// false = establish baseline without sending a flood of old listings.
const SEND_EXISTING_ON_FIRST_RUN =
  String(process.env.SEND_EXISTING_ON_FIRST_RUN || "false").toLowerCase() ===
  "true";

// true = send an alert if the same BMS code's content changes later.
const ALERT_ON_CHANGE =
  String(process.env.ALERT_ON_CHANGE || "false").toLowerCase() === "true";

// Delay between Telegram messages.
// Telegram has rate limits, so don't hammer the API.
const TELEGRAM_DELAY_MS = Number(
  process.env.TELEGRAM_DELAY_MS || 1200
);

// Maximum Telegram message size.
// Telegram allows about 4096 chars for text messages.
// Keep a little safety margin.
const TELEGRAM_MAX_LENGTH = 3900;

// Request timeout.
const HTTP_TIMEOUT_MS = Number(
  process.env.HTTP_TIMEOUT_MS || 15000
);

/*
|--------------------------------------------------------------------------
| Location keywords
|--------------------------------------------------------------------------
| Add/remove locations here.
|--------------------------------------------------------------------------
*/

const KEYWORDS = [
  // English
  "dhanmondi",
  "mohammadpur",
  "muhammadpur",
  "farmgate",
  "firmgate",
  "jigatola",
  "jigatala",
  "mohakhali",
  "badda",
  "east badda",
  "south badda",
  "north badda",
  "uttar badda",
  "rampura",
  "mirpur",
  "mirpur 1",
  "mirpur 2",
  "mirpur 6",
  "mirpur 10",
  "mirpur 14",
  "adabor",
  "shamoli",
  "shemoli",
  "semoli",
  "lalmatia",
  "tejgaon",
  "tejturi bazar",
  "lalmatia",
  "hazaribag",
  "hazaribagh",

  // Bengali
  "বাড্ডা",
  "জিগাতলা",
  "জিগাতোলা",
  "শেওড়াপাড়া",
  "শ্যামলী",
  "রামপুরা",
  "নর্দা",
  "মোহাম্মদপুর",
  "চন্দ্রিমা",
  "মহাখালী",
  "লালমাটিয়া",
  "ধানমন্ডি",
  "বিজয়"
];

/*
|--------------------------------------------------------------------------
| Validation
|--------------------------------------------------------------------------
*/

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN is missing.");
  console.error("Create a .env file and add BOT_TOKEN=...");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("ERROR: CHAT_ID is missing.");
  console.error("Create a .env file and add CHAT_ID=...");
  process.exit(1);
}

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchText(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[|,.;:_/\\()[\]{}#@!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function extractBmsCode(text) {
  const match = String(text || "").match(/\bBMS\d+[A-Za-z]?\b/i);
  return match ? match[0].toUpperCase() : "";
}

function extractPhoneNumber(text) {
  if (!text) return "";

  // +880 1629023242
  // +880-1629023242
  // +8801629023242
  const intlMatch = text.match(/\+880[\s-]?\d{10}/);

  if (intlMatch) {
    return intlMatch[0]
      .replace(/[\s-]/g, "")
      .trim();
  }

  // Local Bangladeshi mobile format: 01XXXXXXXXX
  const localMatch = text.match(/\b01\d{9}\b/);

  if (localMatch) {
    return localMatch[0];
  }

  return "";
}

function extractContact(text, html = "") {
  const combined = `${text || ""} ${html || ""}`;

  /*
   * Match WhatsApp URLs such as:
   * https://wa.me/+8801410544502
   * https://wa.me/8801410544502
   */
  const waMatch = combined.match(
    /wa\.me\/(?:\+)?(\d{10,15})/i
  );

  if (waMatch) {
    return `+${waMatch[1]}`;
  }

  // Match text phone number.
  return extractPhoneNumber(text);
}

function cleanDescription(text) {
  let value = normalizeText(text);

  /*
   * Remove the message-code/contact tail.
   *
   * Examples:
   * Message code to To +8801410544502
   * Contact: Message code to To +8801410544502
   */
  value = value.replace(
    /\s*\|?\s*Contact\s*:\s*Message code.*$/i,
    ""
  );

  value = value.replace(
    /\s+Message code\s+to\s+To\s+\+?880[\s-]?\d{10,}$/i,
    ""
  );

  value = value.replace(
    /\s+Message code.*$/i,
    ""
  );

  value = normalizeText(value);

  return value;
}

function extractLocation(description) {
  if (!description) return "";

  let text = normalizeText(description);

  // Remove BMS code if still present.
  text = text.replace(
    /^\s*BMS\d+[A-Za-z]?\s*/i,
    ""
  );

  /*
   * Preferred format:
   *
   * BMS9234 Badda Satarkul, Badda | Class 12 ...
   *
   * Then location is the first pipe section.
   */
  if (text.includes("|")) {
    const firstPart = text.split("|")[0];
    return normalizeText(firstPart);
  }

  /*
   * For plain format:
   *
   * Dhanmondi Central Road class 6, ...
   *
   * Take everything before class/SSC/HSC/etc.
   */
  const locationMatch = text.match(
    /^(.+?)(?=\s+(?:cls|class|classs|ssc|hsc|o\s*lvl|medical\s+admission|admission|ielts|undergraduate)\b)/i
  );

  if (locationMatch) {
    return normalizeText(locationMatch[1]);
  }

  /*
   * Fallback: use the beginning of the record.
   */
  const fallback = text.split(",")[0];

  return normalizeText(
    fallback.substring(0, 150)
  );
}

function matchesKeyword(record) {
  const searchText = normalizeSearchText(
    `${record.location} ${record.description}`
  );

  for (const keyword of KEYWORDS) {
    const normalizedKeyword = normalizeSearchText(keyword);

    if (!normalizedKeyword) {
      continue;
    }

    // Bengali / non-Latin: direct substring matching.
    if (/[\u0980-\u09FF]/.test(keyword)) {
      if (searchText.includes(normalizedKeyword)) {
        return true;
      }
      continue;
    }

    /*
     * English:
     *
     * Use substring matching rather than strict word boundaries
     * because the site has inconsistent punctuation/spelling.
     *
     * Example:
     * "Mirpur-14"
     * "Mirpur 14"
     * "Dhanmondi7A"
     */
    if (searchText.includes(normalizedKeyword)) {
      return true;
    }
  }

  return false;
}

function extractRecord(text, html = "") {
  const normalized = normalizeText(text);

  const code = extractBmsCode(normalized);

  if (!code) {
    return null;
  }

  let description = normalized
    .replace(
      new RegExp(`^\\s*${code}\\s*`, "i"),
      ""
    )
    .trim();

  const contact = extractContact(normalized, html);

  description = cleanDescription(description);

  if (!description) {
    return null;
  }

  const location = extractLocation(description);

  const fullTextParts = [
    code,
    location ? `Location: ${location}` : "",
    description,
    contact ? `Contact: ${contact}` : ""
  ].filter(Boolean);

  const fullText = fullTextParts.join(" | ");

  return {
    code,
    location,
    description,
    contact,
    fullText
  };
}

/*
|--------------------------------------------------------------------------
| HTTP
|--------------------------------------------------------------------------
*/

async function fetchWebsiteContent() {
  const response = await axios.get(TARGET_URL, {
    timeout: HTTP_TIMEOUT_MS,

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/153.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language":
        "en-US,en;q=0.9,bn;q=0.8"
    }
  });

  return response.data;
}

/*
|--------------------------------------------------------------------------
| Scraping - Paragraph based
|--------------------------------------------------------------------------
*/

function extractParagraphRecords($) {
  const records = [];

  const paragraphs = $("p").toArray();

  for (let i = 0; i < paragraphs.length; i++) {
    const current = $(paragraphs[i]);

    const currentText = normalizeText(
      current.text()
    );

    const currentHtml =
      current.html() || "";

    const currentCode =
      extractBmsCode(currentText);

    /*
     * Ignore paragraphs that don't begin/contain a BMS record.
     */
    if (!currentCode) {
      continue;
    }

    let combinedText = currentText;
    let combinedHtml = currentHtml;

    /*
     * Some versions of the website put:
     *
     * BMSxxxx ...
     *
     * Message code ...
     *
     * into separate paragraphs.
     *
     * Add only obvious continuation paragraphs.
     */
    for (let j = i + 1; j < paragraphs.length; j++) {
      const next = $(paragraphs[j]);

      const nextText = normalizeText(
        next.text()
      );

      const nextHtml =
        next.html() || "";

      if (!nextText) {
        continue;
      }

      // Stop when the next actual tuition record starts.
      if (extractBmsCode(nextText)) {
        break;
      }

      const isMessageContinuation =
        /message\s+code/i.test(nextText) ||
        /whatsapp/i.test(nextText) ||
        /wa\.me/i.test(nextHtml) ||
        /\+880[\s-]?\d{10}/.test(nextText) ||
        /\b01\d{9}\b/.test(nextText);

      if (!isMessageContinuation) {
        break;
      }

      combinedText += ` ${nextText}`;
      combinedHtml += ` ${nextHtml}`;
    }

    const record = extractRecord(
      combinedText,
      combinedHtml
    );

    if (record) {
      records.push(record);
    }
  }

  return records;
}

/*
|--------------------------------------------------------------------------
| Scraping - Table based
|--------------------------------------------------------------------------
|
| Kept for backward compatibility.
|--------------------------------------------------------------------------
*/

function extractTableRecords($) {
  const records = [];

  $(
    "figure.wp-block-table table, table"
  ).each((_, table) => {
    $(table)
      .find("tbody tr")
      .each((_, tr) => {
        const tds = $(tr).find("td");

        if (tds.length < 2) {
          return;
        }

        const code = extractBmsCode(
          normalizeText(tds.eq(0).text())
        );

        if (!code) {
          return;
        }

        const description =
          normalizeText(tds.eq(1).text());

        if (!description) {
          return;
        }

        const contactText =
          tds.length >= 3
            ? normalizeText(tds.eq(2).text())
            : "";

        const date =
          tds.length >= 4
            ? normalizeText(tds.eq(3).text())
            : "";

        const contact =
          extractContact(contactText);

        const record = extractRecord(
          `${code} ${description}`,
          ""
        );

        if (!record) {
          return;
        }

        if (contact) {
          record.contact = contact;
        }

        if (date) {
          record.date = date;
        }

        record.fullText = [
          record.code,
          record.location
            ? `Location: ${record.location}`
            : "",
          record.description,
          record.contact
            ? `Contact: ${record.contact}`
            : "",
          record.date
            ? `Date: ${record.date}`
            : ""
        ]
          .filter(Boolean)
          .join(" | ");

        records.push(record);
      });
  });

  return records;
}

/*
|--------------------------------------------------------------------------
| Deduplication
|--------------------------------------------------------------------------
*/

function deduplicateRecords(records) {
  const map = new Map();

  for (const record of records) {
    if (!record || !record.code) {
      continue;
    }

    const code = record.code.toUpperCase();

    const existing = map.get(code);

    if (!existing) {
      map.set(code, record);
      continue;
    }

    /*
     * Keep the richer record.
     * This also handles duplicate entries such as the same
     * BMS code appearing more than once on the page.
     */
    const existingScore =
      existing.description.length +
      (existing.contact ? 50 : 0);

    const newScore =
      record.description.length +
      (record.contact ? 50 : 0);

    if (newScore > existingScore) {
      map.set(code, record);
    }
  }

  return [...map.values()];
}

/*
|--------------------------------------------------------------------------
| State file
|--------------------------------------------------------------------------
*/

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      version: 2,
      entries: {},
      isNew: true
    };
  }

  try {
    const raw = fs.readFileSync(
      STATE_PATH,
      "utf8"
    );

    const parsed = JSON.parse(raw);

    /*
     * New format
     */
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 2 &&
      parsed.entries &&
      typeof parsed.entries === "object"
    ) {
      return {
        ...parsed,
        isNew: false
      };
    }

    /*
     * Migration from the original format:
     *
     * [
     *   "BMS9234 | ...",
     *   "BMS9233 | ..."
     * ]
     */
    if (Array.isArray(parsed)) {
      const entries = {};

      for (const oldItem of parsed) {
        if (typeof oldItem !== "string") {
          continue;
        }

        const code = extractBmsCode(oldItem);

        if (!code) {
          continue;
        }

        entries[code] = {
          fingerprint: sha256(
            normalizeText(oldItem)
          ),
          lastSeen: null,
          migrated: true
        };
      }

      return {
        version: 2,
        entries,
        isNew: false
      };
    }

    console.warn(
      "State file format not recognized. Starting with empty state."
    );

    return {
      version: 2,
      entries: {},
      isNew: true
    };
  } catch (error) {
    console.warn(
      "Could not read sent_updates.json:",
      error.message
    );

    return {
      version: 2,
      entries: {},
      isNew: true
    };
  }
}

function saveState(state) {
  const output = {
    version: 2,
    entries: state.entries
  };

  const tempPath =
    `${STATE_PATH}.tmp`;

  fs.writeFileSync(
    tempPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  /*
   * Atomic-ish replacement:
   * write temp first, then rename.
   */
  fs.renameSync(
    tempPath,
    STATE_PATH
  );
}

/*
|--------------------------------------------------------------------------
| Telegram
|--------------------------------------------------------------------------
*/

async function sendTelegramMessage(message) {
  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const chunks = splitTelegramMessage(
    message,
    TELEGRAM_MAX_LENGTH
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    try {
      await axios.post(
        url,
        {
          chat_id: CHAT_ID,
          text: chunk,
          disable_web_page_preview: true
        },
        {
          timeout: HTTP_TIMEOUT_MS
        }
      );
    } catch (error) {
      console.error(
        "Telegram API error:",
        error.response?.data ||
          error.message
      );

      throw error;
    }

    if (i < chunks.length - 1) {
      await sleep(TELEGRAM_DELAY_MS);
    }
  }
}

function splitTelegramMessage(
  message,
  maxLength
) {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks = [];

  let remaining = message;

  while (remaining.length > maxLength) {
    let splitAt =
      remaining.lastIndexOf(
        "\n",
        maxLength
      );

    if (splitAt < 100) {
      splitAt =
        remaining.lastIndexOf(
          " ",
          maxLength
        );
    }

    if (splitAt < 100) {
      splitAt = maxLength;
    }

    chunks.push(
      remaining.slice(0, splitAt)
    );

    remaining =
      remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function formatAlert(record, type) {
  const title =
    type === "changed"
      ? "🔄 Tuition Updated"
      : "🔔 New Tuition Alert";

  const lines = [
    title,
    "",
    `Code: ${record.code}`
  ];

  if (record.location) {
    lines.push(
      `Location: ${record.location}`
    );
  }

  lines.push(
    `Details: ${record.description}`
  );

  if (record.contact) {
    lines.push(
      `Contact: ${record.contact}`
    );
  }

  lines.push(
    "",
    `Source: ${TARGET_URL}`
  );

  return lines.join("\n");
}

/*
|--------------------------------------------------------------------------
| Main
|--------------------------------------------------------------------------
*/

async function main() {
  console.log(
    "========================================"
  );
  console.log(
    " Dhaka Tuition Alert"
  );
  console.log(
    "========================================"
  );

  console.log(
    `Target: ${TARGET_URL}`
  );

  console.log(
    `Started: ${new Date().toISOString()}`
  );

  /*
   * Load current state.
   */
  const state = loadState();

  /*
   * Fetch page.
   */
  console.log(
    "Fetching website..."
  );

  const html =
    await fetchWebsiteContent();

  console.log(
    `Downloaded ${html.length} bytes.`
  );

  /*
   * Parse HTML.
   */
  const $ = cheerio.load(html);

  /*
   * Extract from current paragraph format.
   */
  const paragraphRecords =
    extractParagraphRecords($);

  console.log(
    `Paragraph records: ${paragraphRecords.length}`
  );

  /*
   * Extract old table format too.
   */
  const tableRecords =
    extractTableRecords($);

  console.log(
    `Table records: ${tableRecords.length}`
  );

  /*
   * Merge.
   */
  const allRecords = [
    ...paragraphRecords,
    ...tableRecords
  ];

  /*
   * Deduplicate by BMS code.
   */
  const uniqueRecords =
    deduplicateRecords(allRecords);

  console.log(
    `Unique BMS records: ${uniqueRecords.length}`
  );

  /*
   * Find matching locations.
   */
  const matchingRecords =
    uniqueRecords.filter(matchesKeyword);

  console.log(
    `Keyword matches: ${matchingRecords.length}`
  );

  /*
   * Debug output.
   */
  for (const record of matchingRecords) {
    console.log(
      `[MATCH] ${record.code} | ${record.location}`
    );
  }

  /*
   * First run:
   *
   * Default behavior is to establish a baseline
   * without sending all historical listings.
   */
  if (state.isNew && !SEND_EXISTING_ON_FIRST_RUN) {
    console.log(
      "No existing state detected."
    );

    console.log(
      "Creating baseline without sending existing matches."
    );

    const now =
      new Date().toISOString();

    for (const record of uniqueRecords) {
      state.entries[record.code] = {
        fingerprint: sha256(
          normalizeText(record.fullText)
        ),
        lastSeen: now,
        location: record.location
      };
    }

    saveState(state);

    console.log(
      `Baseline created with ${uniqueRecords.length} records.`
    );

    console.log(
      "Future runs will alert only on new matching records."
    );

    return;
  }

  /*
   * Process alerts.
   */
  const alerts = [];

  const now =
    new Date().toISOString();

  for (const record of uniqueRecords) {
    const code =
      record.code.toUpperCase();

    const fingerprint =
      sha256(
        normalizeText(record.fullText)
      );

    const previous =
      state.entries[code];

    /*
     * Brand-new BMS code.
     */
    if (!previous) {
      if (matchesKeyword(record)) {
        alerts.push({
          record,
          type: "new"
        });
      }

      state.entries[code] = {
        fingerprint,
        lastSeen: now,
        location: record.location
      };

      continue;
    }

    /*
     * Existing record changed.
     */
    if (
      ALERT_ON_CHANGE &&
      previous.fingerprint !== fingerprint &&
      matchesKeyword(record)
    ) {
      alerts.push({
        record,
        type: "changed"
      });
    }

    /*
     * Always update state with newest content.
     */
    state.entries[code] = {
      fingerprint,
      lastSeen: now,
      location: record.location
    };
  }

  /*
   * Cleanup:
   *
   * If old BMS records disappear from the page for a long time,
   * don't immediately delete them. This prevents re-alerting if
   * the website temporarily fails to show older records.
   *
   * Instead, keep them indefinitely.
   */

  console.log(
    `Alerts to send: ${alerts.length}`
  );

  /*
   * Send alerts.
   */
  let sentCount = 0;

  for (const alert of alerts) {
    const message =
      formatAlert(
        alert.record,
        alert.type
      );

    console.log(
      `Sending ${alert.type}: ${alert.record.code}`
    );

    try {
      await sendTelegramMessage(
        message
      );

      sentCount++;

      console.log(
        `✓ Sent ${alert.record.code}`
      );
    } catch (error) {
      /*
       * Important:
       *
       * Do NOT remove the record from state here.
       * However, because the state was already updated above,
       * a failed Telegram send would otherwise never retry.
       *
       * Restore old state for this code so the next run
       * can try again.
       */
      const code =
        alert.record.code.toUpperCase();

      if (
        alert.type === "new"
      ) {
        delete state.entries[code];
      }

      console.error(
        `✗ Failed to send ${code}`
      );
    }

    await sleep(
      TELEGRAM_DELAY_MS
    );
  }

  /*
   * Save state only after processing.
   */
  saveState(state);

  console.log(
    "----------------------------------------"
  );
  console.log(
    `Total records: ${uniqueRecords.length}`
  );
  console.log(
    `Matching records: ${matchingRecords.length}`
  );
  console.log(
    `Alerts sent: ${sentCount}`
  );
  console.log(
    `Finished: ${new Date().toISOString()}`
  );
  console.log(
    "----------------------------------------"
  );
}

/*
|--------------------------------------------------------------------------
| Global error handler
|--------------------------------------------------------------------------
*/

main().catch((error) => {
  console.error(
    "========================================"
  );
  console.error(
    "FATAL ERROR"
  );
  console.error(
    "========================================"
  );

  console.error(
    error.response?.data ||
      error.stack ||
      error.message ||
      error
  );

  process.exit(1);
});
