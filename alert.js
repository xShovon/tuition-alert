const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const BOT_TOKEN = "7453745620:AAGcFqCnxXgJsgWguvtIsjQCw3krqtWdOac";
const CHAT_ID = "5659693980";
const TARGET_URL = "https://dhakatuitionbd.com/bm/";

const KEYWORDS = ["dhanmondi", "Mohammadpur", "farmgate", "jigatola", "mohakhali", "badda", "rampura", "mirpur", "adabor", "shamoli", "lalmatia", "jigatala", "Muhammadpur", "Tejgaon","বাড্ডা","জিগাতলা","শেওড়াপাড়া","শ্যামলী","রামপুরা","নর্দা","মোহাম্মদপুর","চন্দ্রিমা","মহাখালী","লালমাটিয়া","ধানমন্ডি","বিজয়","Zigatola"]; // Add more as needed
const SENT_UPDATES_PATH = "./sent_updates.json";

// Load sent updates
let sentUpdates = [];
if (fs.existsSync(SENT_UPDATES_PATH)) {
  try {
    sentUpdates = JSON.parse(fs.readFileSync(SENT_UPDATES_PATH));
  } catch (e) {
    console.warn("Could not parse sent_updates.json — starting fresh.");
    sentUpdates = [];
  }
}

async function fetchWebsiteContent() {
  const response = await axios.get(TARGET_URL);
  return response.data;
}

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: CHAT_ID,
    text: message,
  });
}

function cleanText(text) {
  // remove wa.me links shown as text, normalize whitespace
  return text.replace(/https?:\/\/wa\.me\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function extractFromStyle1(text) {
  // Style 1: 📍 কলাবাগান গ্রিন রোড | SSC–26 | বাংলা, ইং, সমাজ | 💰 ৬k/৪ দিন | 👨 পুরুষ (DU) | BMS1148 | 📲 Whatsapp code +880 1410-544502
  
  // Clean text and remove emojis for processing
  const cleanedText = text.replace(/[\u{1F000}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, "").trim();
  
  // Try to extract tuition code (format like BMS1148)
  const codeMatch = cleanedText.match(/BMS\d+/i);
  const code = codeMatch ? codeMatch[0] : "";
  
  // Extract location (after 📍 emoji or at the beginning)
  const locationMatch = cleanedText.match(/^\s*([^|]+)/);
  const location = locationMatch ? locationMatch[1].trim() : "";
  
  // Extract subjects and details
  const parts = cleanedText.split("|").map(part => part.trim());
  
  // Extract contact information
  const contactMatch = text.match(/Whatsapp code ([^|]+)/i) || text.match(/\+880\s*\d{4}-\d{6}/);
  const contact = contactMatch ? contactMatch[1] || contactMatch[0] : "";
  
  return {
    code,
    location,
    description: cleanedText,
    contact,
    fullText: `${code} | ${cleanedText} | Contact: ${contact}`.replace(/\|\s*\|/g, "|").trim()
  };
}

function extractFromStyle2(text) {
  // Style 2: BMS1103 "Eskaton Garden Cls 10 Phy Chem Eng Version, 6k /3d Male Or Female Du Physics Or Chem Department 2/3/4th Year Student" Message code https://wa.me/+8801410544502
  
  const cleanedText = cleanText(text);
  
  // Extract tuition code
  const codeMatch = cleanedText.match(/BMS\d+/i);
  const code = codeMatch ? codeMatch[0] : "";
  
  // Extract quoted description or main description
  const quotedMatch = cleanedText.match(/"([^"]+)"/);
  const description = quotedMatch ? quotedMatch[1] : cleanedText.replace(/BMS\d+\s*/i, "").replace(/Message code.*$/i, "").trim();
  
  // Extract location from description (first part before class info)
  const locationMatch = description.match(/^([^C][^l][^s]*?)(?=\s*Cls|\s*Class|\s*HSC|\s*SSC)/i);
  const location = locationMatch ? locationMatch[1].trim() : "";
  
  // Extract contact
  const contactMatch = text.match(/https:\/\/wa\.me\/\+(\d+)/);
  const contact = contactMatch ? `+${contactMatch[1]}` : "";
  
  return {
    code,
    location,
    description,
    contact,
    fullText: `${code} | ${description} | Contact: ${contact}`.replace(/\|\s*\|/g, "|").trim()
  };
}

(async () => {
  try {
    const html = await fetchWebsiteContent();
    const $ = cheerio.load(html);
    const updates = [];

    console.log("Scraping tuition updates...");

    // METHOD 1: Handle new Style 1 & 2 - paragraph-based structure
    $("p.wp-block-paragraph").each((_, p) => {
      const text = $(p).text().trim();
      const html = $(p).html();
      
      // Skip empty paragraphs
      if (!text) return;
      
      let extractedData = null;
      
      // Check if it's Style 1 (contains emoji images OR Unicode emojis)
      const hasEmojiImages = html && (html.includes('alt="📍"') || html.includes('alt="💰"') || html.includes('alt="📲"') || html.includes('class="emoji"'));
      const hasUnicodeEmojis = text.includes("📍") || text.includes("💰") || text.includes("📲");
      const hasBengaliPattern = /[\u0980-\u09FF]/.test(text); // Bengali Unicode range
      
      if (hasEmojiImages || hasUnicodeEmojis || (hasBengaliPattern && text.includes('|'))) {
        extractedData = extractFromStyle1(text);
        console.log(`Detected Style 1 (Bengali/Emoji): ${extractedData?.code}`);
      }
      // Check if it's Style 2 (starts with BMS code and has quotes or wa.me link)
      else if (text.match(/BMS\d+/i) && (text.includes('"') || text.includes("wa.me"))) {
        extractedData = extractFromStyle2(text);
        // Only log if we find a match to reduce noise
      }
      
      if (extractedData && extractedData.description) {
        // Check keywords in the location and description (case-insensitive for English, exact for Bengali)
        const searchText = `${extractedData.location} ${extractedData.description}`;
        const matchesKeyword = KEYWORDS.some((keyword) => {
          // For Bengali keywords, do exact match; for English, case-insensitive
          if (/[\u0980-\u09FF]/.test(keyword)) {
            return searchText.includes(keyword);
          } else {
            return searchText.toLowerCase().includes(keyword.toLowerCase());
          }
        });

        if (matchesKeyword) {
          console.log(`Found matching update: ${extractedData.code}`);
          updates.push(extractedData.fullText);
        } else {
          console.log(`No keyword match for: ${extractedData.code} - ${extractedData.location}`);
        }
      }
    });

    // METHOD 2: Handle old table-based structure (for backward compatibility)
    $("figure.wp-block-table table.has-fixed-layout tbody tr").each((_, tr) => {
      const tds = $(tr).find("td");
      // Skip rows that don't have the expected columns or are empty
      if (tds.length < 2) return;

      // Column mapping from original structure:
      // td[0] = code, td[1] = description, td[2] = contact (wa.me), td[3] = date
      const code = tds.eq(0).text().trim();
      const description = cleanText(tds.eq(1).text().trim());
      const contact = cleanText(tds.eq(2).text().trim());
      const date = tds.eq(3) ? tds.eq(3).text().trim() : "";

      // If description empty, skip (these are the blank spacer rows in the HTML)
      if (!description) return;

      // Build a single text payload to check/store/send
      const combinedText = `${code ? code + " | " : ""}${description}${contact ? " | " + contact : ""}${date ? " | " + date : ""}`;

      // Check keywords in the description (case-insensitive)
      const matchesKeyword = KEYWORDS.some((keyword) =>
        description.toLowerCase().includes(keyword.toLowerCase())
      );

      if (matchesKeyword) {
        console.log(`Found matching table update: ${code}`);
        updates.push(combinedText);
      }
    });

    // METHOD 3: Fallback - look for any paragraph containing BMS codes and keywords (including Bengali text)
    if (updates.length === 0) {
      console.log("No updates found with primary methods, trying fallback...");
      
      $("p").each((_, p) => {
        const text = $(p).text().trim();
        
        // Look for BMS codes OR Bengali tuition patterns
        if (text.match(/BMS\d+/i) || /[\u0980-\u09FF]/.test(text)) {
          const searchText = text.toLowerCase();
          const matchesKeyword = KEYWORDS.some((keyword) => {
            // For Bengali keywords, do exact match; for English, case-insensitive
            if (/[\u0980-\u09FF]/.test(keyword)) {
              return text.includes(keyword);
            } else {
              return searchText.includes(keyword.toLowerCase());
            }
          });

          if (matchesKeyword) {
            console.log(`Found fallback update: ${text.substring(0, 50)}...`);
            updates.push(cleanText(text));
          }
        }
      });
    }

    // METHOD 4: Enhanced search for all paragraphs with Bengali text and relevant keywords
    console.log("Checking for Bengali content...");
    $("p").each((_, p) => {
      const text = $(p).text().trim();
      
      // Skip if already processed or empty
      if (!text || updates.some(update => update.includes(text.substring(0, 30)))) return;
      
      // Look for Bengali text with tuition-related keywords
      if (/[\u0980-\u09FF]/.test(text)) {
        // Check for tuition-related Bengali words or numbers
        const hasTuitionKeywords = text.includes('ক্লাস') || text.includes('টিউশন') || text.includes('শিক্ষক') || 
                                  text.includes('ছাত্র') || text.includes('পড়ান') || /\d+k/.test(text) || /\d+\/\d+/.test(text);
        
        if (hasTuitionKeywords) {
          const matchesLocation = KEYWORDS.some((keyword) => {
            if (/[\u0980-\u09FF]/.test(keyword)) {
              return text.includes(keyword);
            } else {
              return text.toLowerCase().includes(keyword.toLowerCase());
            }
          });
          
          if (matchesLocation) {
            console.log(`Found Bengali tuition: ${text.substring(0, 100)}...`);
            updates.push(text);
          }
        }
      }
    });

    console.log(`Total updates found: ${updates.length}`);

    // Filter out already-sent updates
    const newUpdates = updates.filter((update) => !sentUpdates.includes(update));
    console.log(`New updates to send: ${newUpdates.length}`);

    for (const update of newUpdates) {
      try {
        console.log(`Sending: ${update.substring(0, 100)}...`);
        await sendTelegramMessage(update);
        sentUpdates.push(update);
        console.log("✓ Sent successfully");
      } catch (sendErr) {
        console.error("Failed to send update to Telegram:", sendErr.message);
      }
    }

    // Save updated list
    fs.writeFileSync(SENT_UPDATES_PATH, JSON.stringify(sentUpdates, null, 2));
    console.log(`✓ Sent ${newUpdates.length} new update(s).`);
    
    if (newUpdates.length === 0) {
      console.log("No new updates found.");
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
})();
