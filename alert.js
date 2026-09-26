const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

// IMPORTANT:
// The previous bot token was exposed. Generate a NEW token using
// @BotFather and put the new token below.
const BOT_TOKEN = "7453745620:AAGcFqCnxXgJsgWguvtIsjQCw3krqtWdOac";
const CHAT_ID = "5659693980";

const TARGET_URL = "https://dhakatuitionbd.com/bm/";

const KEYWORDS = [
  // English
  "dhanmondi",
  "mohammadpur",
  "farmgate",
  "firmgate",
  "farm gate",
  "firm gate",
  "jigatola",
  "zigatola",
  "mohakhali",
  "badda",
  "rampura",
  "mirpur",
  "adabor",
  "shamoli",
  "shyamoli",
  "lalmatia",
  "tejgaon",
  "norda",
  "chandrima",
  "bijoy",

  // Bengali
  "বাড্ডা",
  "জিগাতলা",
  "শেওড়াপাড়া",
  "শেওড়াপাড়া",
  "শ্যামলী",
  "রামপুরা",
  "নর্দা",
  "মোহাম্মদপুর",
  "চন্দ্রিমা",
  "মহাখালী",
  "লালমাটিয়া",
  "লালমাটিয়া",
  "ধানমন্ডি",
  "বিজয়",
  "বিজয়",
];

// Always store state next to this script, not relative to the
// directory from which Node happens to be launched.
const SENT_UPDATES_PATH = path.join(__dirname, "sent_updates.json");

// ============================================================
// HELPERS
// ============================================================

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(text) {
  return normalizeWhitespace(
    String(text || "")
      // Remove visible wa.me links from the description
      .replace(/https?:\/\/wa\.me\/\S+/gi, "")
  );
}

// Supports:
// BMS1148
// BMS9199
// BMS9199B
// BMS9199A
function extractCode(text) {
  const match = String(text || "").match(/\bBMS\d+[A-Za-z]?\b/i);
  return match ? match[0].toUpperCase() : "";
}

// Extract Bangladesh phone numbers in formats such as:
//
// +8801410544502
// +880 1410544502
// +880 1410-544502
// 01410-544502
// https://wa.me/+8801410544502
// Message code to To +8801410544502
function extractContact(text) {
  const source = String(text || "");

  // International format
  let match = source.match(/\+880[\s-]?1[3-9](?:[\s-]?\d){8}/i);

  if (match) {
    return match[0].replace(/[\s-]/g, "");
  }

  // wa.me/880... or wa.me/+880...
  match = source.match(/wa\.me\/\+?880[\s-]?1[3-9](?:[\s-]?\d){8}/i);

  if (match) {
    let number = match[0]
      .replace(/^wa\.me\//i, "")
      .replace(/[\s-]/g, "");

    if (!number.startsWith("+")) {
      number = "+" + number;
    }

    return number;
  }

  // Local Bangladesh mobile number
  match = source.match(/\b01[3-9](?:[\s-]?\d){8}\b/);

  if (match) {
    const local = match[0].replace(/[\s-]/g, "");

    // Convert 01XXXXXXXXX -> +8801XXXXXXXXX
    return "+880" + local.substring(1);
  }

  return "";
}

function containsKeyword(text) {
  const searchText = normalizeWhitespace(text).toLowerCase();

  return KEYWORDS.some((keyword) => {
    const normalizedKeyword = normalizeWhitespace(keyword).toLowerCase();
    return searchText.includes(normalizedKeyword);
  });
}

function removeCodeFromText(text) {
  return cleanText(
    String(text || "").replace(/\bBMS\d+[A-Za-z]?\b/i, "")
  );
}

// Try to identify the location from a description.
// Examples:
//
// Dhanmondi Central Road class 6...
// -> Dhanmondi Central Road
//
// Eskaton Garden Cls 10...
// -> Eskaton Garden
//
// Dhanmondi 15 | Class 8...
// -> Dhanmondi 15
function extractLocation(description) {
  const text = normalizeWhitespace(description);

  if (!text) return "";

  // Prefer pipe-separated structure.
  if (text.includes("|")) {
    const firstPart = text.split("|")[0].trim();
    if (firstPart) {
      return firstPart;
    }
  }

  // Stop before common academic markers.
  const locationMatch = text.match(
    /^(.+?)(?=\s+(?:Cls|Class|HSC|SSC|JSC|KG|Nursery|Honours|Honors)\b|,\s*(?:Class|Cls)\b)/i
  );

  if (locationMatch && locationMatch[1]) {
    return locationMatch[1].trim();
  }

  // Fallback: first reasonable chunk.
  return text.split(",")[0].trim();
}

function buildFullText(code, description, contact, date = "") {
  const parts = [];

  if (code) parts.push(code);
  if (description) parts.push(description);
  if (contact) parts.push(`Contact: ${contact}`);
  if (date) parts.push(date);

  return parts.join(" | ").replace(/\|\s*\|/g, " | ").trim();
}

function makeRecord(rawText) {
  const originalText = normalizeWhitespace(rawText);

  if (!originalText) {
    return null;
  }

  const code = extractCode(originalText);

  if (!code) {
    return null;
  }

  let description = originalText;

  // Remove BMS code
  description = removeCodeFromText(description);

  // Remove common contact suffixes from description
  description = description
    .replace(
      /(?:message\s*code(?:\s+to)?(?:\s+to)?|whatsapp\s*code|contact)\s*:?\s*.*$/i,
      ""
    )
    .trim();

  // Remove trailing separators
  description = description.replace(/\|\s*$/g, "").trim();

  const contact = extractContact(originalText);

  const location = extractLocation(description);

  const fullText = buildFullText(
    code,
    description,
    contact
  );

  return {
    code,
    location,
    description,
    contact,
    fullText,
  };
}

// ============================================================
// LOAD SENT UPDATES
// ============================================================

let sentUpdates = [];

if (fs.existsSync(SENT_UPDATES_PATH)) {
  try {
    const raw = fs.readFileSync(SENT_UPDATES_PATH, "utf8");

    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      sentUpdates = parsed;
    } else if (parsed && typeof parsed === "object") {
      // Support object format in case you later change state format.
      sentUpdates = Object.values(parsed);
    }
  } catch (error) {
    console.warn(
      "Could not parse sent_updates.json — starting fresh."
    );

    sentUpdates = [];
  }
}

// Convert old sent strings to a quick lookup set.
const sentTextSet = new Set(
  sentUpdates
    .filter((item) => typeof item === "string")
    .map((item) => normalizeWhitespace(item))
);

// Build lookup by BMS code.
// This makes old sent_updates.json files compatible.
const sentCodeSet = new Set();

for (const item of sentUpdates) {
  if (typeof item !== "string") continue;

  const code = extractCode(item);

  if (code) {
    sentCodeSet.add(code);
  }
}

// ============================================================
// FETCH WEBSITE
// ============================================================

async function fetchWebsiteContent() {
  const response = await axios.get(TARGET_URL, {
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  return response.data;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  // Telegram has a message length limit.
  const MAX_LENGTH = 4000;

  const chunks = [];

  if (message.length <= MAX_LENGTH) {
    chunks.push(message);
  } else {
    let remaining = message;

    while (remaining.length > MAX_LENGTH) {
      let splitAt = remaining.lastIndexOf("\n", MAX_LENGTH);

      if (splitAt <= 0) {
        splitAt = remaining.lastIndexOf(" ", MAX_LENGTH);
      }

      if (splitAt <= 0) {
        splitAt = MAX_LENGTH;
      }

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trim();
    }

    if (remaining) {
      chunks.push(remaining);
    }
  }

  for (const chunk of chunks) {
    try {
      await axios.post(
        url,
        {
          chat_id: CHAT_ID,
          text: chunk,
          disable_web_page_preview: true,
        },
        {
          timeout: 15000,
        }
      );
    } catch (error) {
      console.error(
        "Telegram error:",
        error.response?.data || error.message
      );

      throw error;
    }
  }
}

// ============================================================
// PARAGRAPH SCRAPER
// ============================================================

function extractParagraphRecords($) {
  const records = [];

  const paragraphs = $("p.wp-block-paragraph");

  let currentRecordParts = [];

  function finalizeCurrentRecord() {
    if (currentRecordParts.length === 0) {
      return;
    }

    const combined = currentRecordParts
      .map((item) => normalizeWhitespace(item))
      .filter(Boolean)
      .join(" | ");

    const record = makeRecord(combined);

    if (record) {
      records.push(record);
    }

    currentRecordParts = [];
  }

  paragraphs.each((_, p) => {
    const text = normalizeWhitespace($(p).text());

    if (!text) {
      return;
    }

    const hasCode = /\bBMS\d+[A-Za-z]?\b/i.test(text);

    // A new BMS code means a new tuition record.
    if (hasCode) {
      finalizeCurrentRecord();

      currentRecordParts.push(text);

      return;
    }

    // Continuation paragraph.
    //
    // The website can put "Message code..." or a WhatsApp link
    // in a separate paragraph, so append those to the active record.
    if (currentRecordParts.length > 0) {
      const looksLikeContact =
        /message\s*code/i.test(text) ||
        /whatsapp/i.test(text) ||
        /wa\.me/i.test(text) ||
        /\+880[\s-]?1[3-9]/i.test(text) ||
        /\b01[3-9][\d\s-]{8,12}\b/.test(text);

      if (looksLikeContact) {
        currentRecordParts.push(text);
      }
    }
  });

  // Final record
  finalizeCurrentRecord();

  return records;
}

// ============================================================
// OLD TABLE STRUCTURE
// ============================================================

function extractTableRecords($) {
  const records = [];

  $("figure.wp-block-table table.has-fixed-layout tbody tr").each(
    (_, tr) => {
      const tds = $(tr).find("td");

      if (tds.length < 2) {
        return;
      }

      const code = normalizeWhitespace(tds.eq(0).text());
      const description = cleanText(tds.eq(1).text());

      const contact =
        tds.length >= 3
          ? extractContact(tds.eq(2).text())
          : "";

      const date =
        tds.length >= 4
          ? normalizeWhitespace(tds.eq(3).text())
          : "";

      if (!description) {
        return;
      }

      const extractedCode =
        extractCode(code) ||
        extractCode(description);

      if (!extractedCode) {
        return;
      }

      const location = extractLocation(description);

      const fullText = buildFullText(
        extractedCode,
        description,
        contact,
        date
      );

      records.push({
        code: extractedCode,
        location,
        description,
        contact,
        fullText,
      });
    }
  );

  return records;
}

// ============================================================
// FALLBACK SCRAPER
// ============================================================

function extractFallbackRecords($) {
  const records = [];

  $("p").each((_, p) => {
    const text = normalizeWhitespace($(p).text());

    if (!text) {
      return;
    }

    if (!/\bBMS\d+[A-Za-z]?\b/i.test(text)) {
      return;
    }

    const record = makeRecord(text);

    if (record) {
      records.push(record);
    }
  });

  return records;
}

// ============================================================
// DEDUPLICATION
// ============================================================

function deduplicateRecords(records) {
  const unique = new Map();

  for (const record of records) {
    if (!record || !record.code) {
      continue;
    }

    const code = record.code.toUpperCase();

    // First complete occurrence wins.
    // If the first one has no contact and a later one does,
    // replace it with the more complete version.
    if (!unique.has(code)) {
      unique.set(code, record);
      continue;
    }

    const existing = unique.get(code);

    const existingScore =
      (existing.contact ? 2 : 0) +
      (existing.description ? 1 : 0);

    const newScore =
      (record.contact ? 2 : 0) +
      (record.description ? 1 : 0);

    if (newScore > existingScore) {
      unique.set(code, record);
    }
  }

  return Array.from(unique.values());
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  try {
    if (
      !BOT_TOKEN ||
      BOT_TOKEN === "PUT_YOUR_NEW_TELEGRAM_BOT_TOKEN_HERE"
    ) {
      throw new Error(
        "Please put your NEW Telegram bot token in BOT_TOKEN."
      );
    }

    console.log("Fetching tuition website...");

    const html = await fetchWebsiteContent();

    const $ = cheerio.load(html);

    console.log("Scraping tuition updates...");

    // ----------------------------------------------------------
    // Extract from current paragraph structure
    // ----------------------------------------------------------

    let records = extractParagraphRecords($);

    console.log(
      `Paragraph records found: ${records.length}`
    );

    // ----------------------------------------------------------
    // Old table structure
    // ----------------------------------------------------------

    const tableRecords = extractTableRecords($);

    console.log(
      `Table records found: ${tableRecords.length}`
    );

    records.push(...tableRecords);

    // ----------------------------------------------------------
    // Fallback if primary parsing found nothing
    // ----------------------------------------------------------

    if (records.length === 0) {
      console.log(
        "No records found with primary methods, using fallback..."
      );

      const fallbackRecords =
        extractFallbackRecords($);

      console.log(
        `Fallback records found: ${fallbackRecords.length}`
      );

      records.push(...fallbackRecords);
    }

    // ----------------------------------------------------------
    // Deduplicate by BMS code
    // ----------------------------------------------------------

    records = deduplicateRecords(records);

    console.log(
      `Unique tuition records found: ${records.length}`
    );

    // ----------------------------------------------------------
    // Keyword filtering
    // ----------------------------------------------------------

    const matchingRecords = records.filter((record) => {
      const searchText = [
        record.location,
        record.description,
      ]
        .filter(Boolean)
        .join(" ");

      const matched = containsKeyword(searchText);

      if (matched) {
        console.log(
          `Keyword match: ${record.code} | ${record.location}`
        );
      }

      return matched;
    });

    console.log(
      `Keyword matching records: ${matchingRecords.length}`
    );

    // ----------------------------------------------------------
    // New update filtering
    // ----------------------------------------------------------

    const newUpdates = matchingRecords.filter((record) => {
      const normalizedFullText =
        normalizeWhitespace(record.fullText);

      // Exact previous message
      if (sentTextSet.has(normalizedFullText)) {
        return false;
      }

      // Previous versions were stored as complete strings.
      // Extract code from those strings and avoid sending
      // the same BMS listing again.
      if (sentCodeSet.has(record.code)) {
        return false;
      }

      return true;
    });

    console.log(
      `New matching updates to send: ${newUpdates.length}`
    );

    // ----------------------------------------------------------
    // Send to Telegram
    // ----------------------------------------------------------

    for (const record of newUpdates) {
      try {
        console.log(
          `Sending ${record.code}: ${record.fullText.substring(
            0,
            100
          )}...`
        );

        await sendTelegramMessage(record.fullText);

        // Save exact message
        sentUpdates.push(record.fullText);

        // Update in-memory sets immediately so duplicate
        // records in the same execution cannot be sent twice.
        sentTextSet.add(
          normalizeWhitespace(record.fullText)
        );

        sentCodeSet.add(record.code);

        console.log(
          `✓ ${record.code} sent successfully`
        );
      } catch (sendErr) {
        console.error(
          `Failed to send ${record.code}:`,
          sendErr.response?.data || sendErr.message
        );
      }
    }

    // ----------------------------------------------------------
    // Save state
    // ----------------------------------------------------------

    fs.writeFileSync(
      SENT_UPDATES_PATH,
      JSON.stringify(sentUpdates, null, 2),
      "utf8"
    );

    console.log(
      `✓ Sent ${newUpdates.length} new update(s).`
    );

    if (newUpdates.length === 0) {
      console.log(
        "No new matching tuition updates found."
      );
    }
  } catch (error) {
    console.error(
      "Scraper error:",
      error.response?.data || error.message
    );

    process.exitCode = 1;
  }
})();
