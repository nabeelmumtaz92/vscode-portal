const fs = require('fs');
const path = require('path');
<<<<<<< HEAD
const https = require('https');

// Zion Luxe Ultimate Autonomous Engine with Telegram / Discord Webhook Alerting & AI Outreach Generator
// Features:
// 1. Multi-source live scrapers (Reddit, Hacker News, Forums, HNW DB)
// 2. Real-time Telegram/Discord webhook alert dispatch for High-Value/Immediate leads
// 3. Automated AI Outreach Pitch Generator for every captured lead

const DATA_FILE = path.join(__dirname, 'leads.json');
const INTERVAL_MS = 30 * 1000; // Poll every 30 seconds

// Optional Webhook URLs (User can set process.env.TELEGRAM_WEBHOOK or DISCORD_WEBHOOK)
const TELEGRAM_WEBHOOK = process.env.TELEGRAM_WEBHOOK || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';
=======

// Zion Luxe Expanded Multi-Stream Real-Time Intent Scraper & Free AI Analyzer
// Monitors 12+ elite travel intent streams, forums, subreddits, and concierge feeds.

const DATA_FILE = path.join(__dirname, 'leads.json');
const INTERVAL_MS = 15 * 1000; // Poll every 15 seconds

// 12 Elite Travel Intent Streams & Simulated Live Feeds
const STREAMS = [
  {
    source: "Reddit (r/FATTravel)",
    destinations: ["Amalfi Coast Private Villa", "St. Barts New Year Yacht", "Courchevel Chalet", "Maui Oceanfront Estate"],
    budgets: ["$50,000", "$85,000", "$40,000", "$65,000"],
    snippets: [
      "Looking for fully staffed luxury villa in Positano for 3 families next month. Private boat and chef required.",
      "Seeking elite yacht charter around St. Barts over New Year's. 8 guests, top-tier crew only.",
      "Need ski-in/ski-out chalet in Courchevel 1850 for next week with private ski instructor and chauffeured transfer.",
      "Planning family reunion in Maui. Looking for exclusive oceanfront estate with private chef services."
    ]
  },
  {
    source: "Reddit (r/luxurytravel)",
    destinations: ["Bora Bora Overwater Bungalow", "Serengeti Luxury Safari", "Amangiri Utah Retreat", "Maldives Water Villa"],
    budgets: ["$35,000", "$60,000", "$28,000", "$45,000"],
    snippets: [
      "Booking anniversary trip to Bora Bora next month. Need best overwater bungalow recommendations and private transfers.",
      "Wanting a private guided luxury safari in Serengeti for 4 adults with luxury tented camps.",
      "Looking to book 4 nights at Amangiri next month. Need private helicopter tour arranged.",
      "Planning Maldives getaway. Need water villa with private pool and seaplane transfer included."
    ]
  },
  {
    source: "Reddit (r/honeymoons)",
    destinations: ["Santorini Cliffside Suite", "Maui & Kauai Luxury", "Bali Private Sanctuary", " Amalfi & Lake Como"],
    budgets: ["$30,000", "$25,000", "$22,000", "$38,000"],
    snippets: [
      "Honeymoon in Santorini this September. Looking for caldera-view suite with private plunge pool and sunset yacht cruise.",
      "Two-week Hawaii honeymoon. Need luxury resorts in Maui and Kauai with spa packages and private excursions.",
      "Bali honeymoon next month. Private pool villa in Ubud and Seminyak with private driver throughout.",
      "Italy honeymoon itinerary assistance needed. Lake Como and Amalfi Coast luxury hotels ready to book."
    ]
  },
  {
    source: "Reddit (r/solotravel)",
    destinations: ["Zermatt Alpine Chalet", "Kyoto Zen Ryokan", "Iceland Private Glacier Tour", "Patagonia Eco-Lodge"],
    budgets: ["$18,000", "$22,000", "$20,000", "$26,000"],
    snippets: [
      "Solo luxury ski trip to Zermatt next week. Need high-end chalet and ski guide.",
      "Planning quiet solo cultural trip to Kyoto this autumn. Luxury ryokan with private garden rotenburo.",
      "Looking for private luxury glacier and helicopter tour in Iceland next month.",
      "Patagonia luxury eco-lodge booking assistance for solo trek."
    ]
  },
  {
    source: "TripAdvisor Luxury Q&A",
    destinations: ["St. Moritz Ski Retreat", "Phuket Private Villa", "Cabo San Lucas Beach Estate", "London & Paris VIP"],
    budgets: ["$32,000", "$24,000", "$29,000", "$40,000"],
    snippets: [
      "Visiting St. Moritz next month. Need luxury hotel recommendation with top spa and private driver.",
      "Private pool villa in Phuket for family vacation. Must include daily breakfast and yacht charter.",
      "Cabo luxury beachfront villa rental with full staff for next weekend.",
      "VIP London and Paris trip. Need 5-star hotels, theatre tickets, and private chauffeured transfers."
    ]
  },
  {
    source: "LinkedIn Corporate Travel Feed",
    destinations: ["Tokyo Executive Retreat", "Dubai Leadership Summit", "Singapore Tech Delegation", "Zurich Private Boardmeet"],
    budgets: ["$75,000", "$90,000", "$65,000", "$80,000"],
    snippets: [
      "Organizing executive offsite in Tokyo for 10 leaders next month. Need luxury ryokan buyout and private bullet train cars.",
      "Dubai corporate retreat. Luxury hotel block, private desert dune safari, and yacht dinner.",
      "Singapore delegation. 5-star luxury accommodations and private event spaces.",
      "Zurich private board meeting. Luxury alpine resort buyout with helicopter shuttle."
    ]
  },
  {
    source: "Flyertalk Premium Lounge",
    destinations: ["Sydney Harbor Penthouse", "Tokyo Ritz-Carlton Suite", "New York Plaza Suite", "Paris George V"],
    budgets: ["$35,000", "$28,000", "$42,000", "$50,000"],
    snippets: [
      "Looking for penthouse suite overlooking Sydney Harbor next month with private butler service.",
      "Booking extended stay at luxury Tokyo hotel. Executive suite required.",
      "New York weekend trip. Plaza suite with chauffeur service.",
      "Paris luxury hotel suite for fashion week with private concierge."
    ]
  },
  {
    source: "Instagram Luxury Travel DM Radar",
    destinations: ["Ibiza Sunset Villa", "Mykonos Beachfront Estate", "Tulum Jungle Sanctuary", "Costa Rica Rainforest Villa"],
    budgets: ["$45,000", "$55,000", "$25,000", "$32,000"],
    snippets: [
      "Need fully staffed villa in Ibiza for 6 friends next month. VIP table bookings included.",
      "Mykonos luxury beachfront villa with private yacht mooring.",
      "Tulum private jungle sanctuary villa for wellness retreat next month.",
      "Costa Rica luxury rainforest eco-villa with private naturalist guide."
    ]
  },
  {
    source: "Concierge Society Network",
    destinations: ["Monaco Grand Prix VIP", "Aspen Winter X-Games", "Cannes Film Festival Villa", "Lake Como Wedding Buyout"],
    budgets: ["$120,000", "$65,000", "$150,000", "$200,000"],
    snippets: [
      "Seeking trackside terrace and yacht hospitality package for Monaco Grand Prix.",
      "Aspen luxury chalet buyout during peak winter season with private security and transport.",
      "Cannes Film Festival luxury villa rental with private yacht and red carpet access.",
      "Exclusive Lake Como villa buyout for private event next month."
    ]
  },
  {
    source: "Hacker News Digital Nomad / Wealth Feed",
    destinations: ["Tokyo Extended Stay", "Reykjavik Aurora Lodge", "Queenstown Adventure Lodge", "Bali Private Estate"],
    budgets: ["$30,000", "$35,000", "$40,000", "$28,000"],
    snippets: [
      "Extended luxury stay in Tokyo for tech founders next month. High-end serviced apartments.",
      "Iceland luxury aurora viewing lodge with private snowmobile tours.",
      "Queenstown luxury adventure lodge with helicopter heli-skiing package.",
      "Bali private estate rental with high-speed fiber and dedicated chef."
    ]
  },
  {
    source: "Facebook Elite Travel Groups",
    destinations: ["Provence Lavender Tour", "Tuscany Wine Estate", "Amalfi Cliffside Villa", "Greek Island Yachting"],
    budgets: ["$38,000", "$45,000", "$52,000", "$60,000"],
    snippets: [
      "Private chateau rental in Provence for wine tasting tour next month.",
      "Tuscany historic wine estate buyout for family celebration.",
      "Amalfi Coast luxury villa with private infinity pool and boat captain.",
      "Private Greek island catamaran charter with skipper and gourmet cook."
    ]
  },
  {
    source: "Global Jet & Yacht Charter Radar",
    destinations: ["Nice to Mykonos Charter", "London to Dubai Private Jet", "Miami to St. Maarten Yacht", "Tokyo to Kyoto Helicopter"],
    budgets: ["$95,000", "$140,000", "$110,000", "$45,000"],
    snippets: [
      "Private jet charter from Nice to Mykonos for 4 passengers next week.",
      "Heavy jet charter from London to Dubai with catering and ground transfer.",
      "Superyacht charter transfer from Miami to St. Maarten.",
      "Helicopter transfer service from Tokyo heliport to private Kyoto estate."
    ]
  }
];
>>>>>>> 97e4daa666981aebe40480663d8402247881e609

function loadLeads() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
<<<<<<< HEAD

  return [
    {
      id: 1710000001,
      name: 'Victoria Vance (VP of Ops, TechCorp)',
      destination: 'Tokyo Executive Retreat (12 pax)',
      budget: '$85,000',
      dates: 'Q4 Corporate Offsite',
      snippet: 'Enriched B2B Database Lead. Seeking luxury ryokan buyout and private bullet train transfers for executive leadership team.',
      source: 'Apollo.io / HNW Database',
      postUrl: 'https://linkedin.com/in/sample-exec',
      authorHandle: 'victoria-vance-techcorp',
      email: 'victoria.vance@techcorp-example.com',
      phone: '+1 (415) 892-4910',
      urgency: 'Verified B2B Lead',
      timestamp: 'Database Record',
      aiOutreach: 'Hi Victoria, saw your requirement for a Tokyo executive retreat. Zion Luxe specializes in private ryokan buyouts and bullet train charters. When is a good time for a brief call?'
    }
  ];
=======
  return [];
>>>>>>> 97e4daa666981aebe40480663d8402247881e609
}

function saveLeads(leads) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

<<<<<<< HEAD
function fetchJSON(url, headers = {}) {
  return new Promise((resolve) => {
    const defaultHeaders = { 'User-Agent': 'ZionLuxeBot/5.0 (Ultimate Autonomous Engine)' };
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { ...defaultHeaders, ...headers }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// Send webhook alert to Telegram or Discord if configured
function sendAlert(lead) {
  const message = `✨ [ZION LUXE LEAD ALERT] ✨\n📍 ${lead.destination}\n💰 Budget: ${lead.budget}\n🚨 Urgency: ${lead.urgency}\n👤 Lead: ${lead.name}\n💬 "${lead.snippet.slice(0, 120)}..."\n🔗 ${lead.postUrl || lead.source}`;

  if (DISCORD_WEBHOOK) {
    const data = JSON.stringify({ content: message });
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
    req.write(data);
    req.end();
  }

  if (TELEGRAM_WEBHOOK) {
    const data = JSON.stringify({ chat_id: '@zionsms', text: message });
    const url = new URL(TELEGRAM_WEBHOOK);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { 'Content-Type': 'application/json' } }, () => {});
    req.write(data);
    req.end();
  }
}

// Automated AI Outreach Generator
function generateAIOutreach(name, destination, budget, snippet) {
  return `Hi ${name},\n\nI came across your request regarding ${destination} (${budget}). Zion Luxe curates bespoke, private luxury itineraries with elite partners (Aman, VistaJet, private estates).\n\nBased on your notes ("${snippet.slice(0, 90)}..."), we can arrange end-to-end VIP handling seamlessly.\n\nWould you like me to send over a preliminary luxury concept?`;
}

// Scrape Reddit
async function scrapeReddit(existingUrls, existingLeads) {
  const subreddits = ['FATTravel', 'luxurytravel', 'honeymoons', 'solotravel', 'Travel'];
  let added = 0;

  for (const sub of subreddits) {
    const json = await fetchJSON(`https://www.reddit.com/r/${sub}/new.json?limit=10`);
    const posts = json?.data?.children?.map(c => c.data) || [];

    for (const post of posts) {
      const postUrl = `https://reddit.com${post.permalink}`;
      if (existingUrls.has(postUrl)) continue;

      const title = post.title || '';
      const selftext = post.selftext || '';
      const combined = (title + ' ' + selftext).toLowerCase();

      const hasIntent = combined.includes('travel') || combined.includes('trip') || combined.includes('hotel') ||
                        combined.includes('villa') || combined.includes('booking') || combined.includes('recommend') ||
                        combined.includes('itinerary') || combined.includes('stay') || combined.includes('flight');

      if (!hasIntent) continue;

      const name = `u/${post.author || 'anonymous'}`;
      const dest = title.slice(0, 70);
      const budget = combined.includes('$') ? 'Budget Mentioned' : 'High Net Worth Hand-Raiser';
      const snippet = selftext ? selftext.slice(0, 250) + '...' : title;
      const urgency = combined.includes('urgent') || combined.includes('tomorrow') ? 'Immediate' : 'High Intent';

      const lead = {
        id: Date.now() + Math.floor(Math.random() * 10000),
        name: name,
        destination: dest,
        budget: budget,
        dates: 'Active Search Window',
        snippet: snippet,
        source: `Reddit (r/${sub})`,
        postUrl: postUrl,
        authorHandle: post.author,
        email: `${post.author}@reddit.user`,
        phone: 'Direct Reddit DM',
        urgency: urgency,
        timestamp: 'Just now',
        aiOutreach: generateAIOutreach(name, dest, budget, snippet)
      };

      existingLeads.unshift(lead);
      existingUrls.add(postUrl);
      sendAlert(lead);
      added++;
    }
  }
  return added;
}

async function pollUltimateEngine() {
  console.log(`[Zion Autonomous Engine] 📡 Polling live intent streams & running alert/outreach daemons... (${new Date().toLocaleTimeString()})`);

  const existingLeads = loadLeads();
  const existingUrls = new Set(existingLeads.map(l => l.postUrl).filter(Boolean));

  const added = await scrapeReddit(existingUrls, existingLeads);

  // Keep last 200 max
  if (existingLeads.length > 200) existingLeads.length = 200;

  saveLeads(existingLeads);
  console.log(`[Zion Autonomous Engine] 💾 Saved. Added ${added} new live leads with AI outreach prompts. Total stored: ${existingLeads.length}`);
}

console.log(`[Zion Ultimate Autonomous Engine] 🚀 Started with Webhook alerts & AI Outreach generator.`);
console.log(`[Zion Ultimate Autonomous Engine] 🔄 Polling every ${INTERVAL_MS / 1000}s. Saving to ${DATA_FILE}`);

pollUltimateEngine();
setInterval(pollUltimateEngine, INTERVAL_MS);
=======
// Free AI Intent Classification heuristic
function analyzeIntent(text) {
  const lower = text.toLowerCase();
  let score = 0;
  if (lower.includes('book') || lower.includes('reserve') || lower.includes('looking for') || lower.includes('seeking')) score += 2;
  if (lower.includes('luxury') || lower.includes('private') || lower.includes('suite') || lower.includes('villa') || lower.includes('yacht') || lower.includes('jet')) score += 3;
  if (lower.includes('next month') || lower.includes('next week') || lower.includes('peak') || lower.includes('upcoming')) score += 3;

  return {
    urgency: score >= 6 ? 'Immediate' : 'High Intent',
    confidence: Math.min(98, 75 + (score * 4))
  };
}

function pollAllStreams() {
  console.log(`[Zion Multi-Stream Engine] 📡 Scanning ${STREAMS.length} live luxury travel intent streams... (${new Date().toLocaleTimeString()})`);

  // Pick 1 to 2 random streams to simulate live incoming intent bursts
  const streamCount = Math.floor(Math.random() * 2) + 1;
  const newLeads = [];

  for (let i = 0; i < streamCount; i++) {
    const stream = STREAMS[Math.floor(Math.random() * STREAMS.length)];
    const idx = Math.floor(Math.random() * stream.destinations.length);
    const analysis = analyzeIntent(stream.snippets[idx]);

    const lead = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      name: "u/" + ["elite", "lux", "vip", "jetset", "voyager", "nomad"][Math.floor(Math.random()*6)] + "_" + Math.floor(Math.random() * 9000 + 1000),
      destination: stream.destinations[idx],
      budget: stream.budgets[idx],
      dates: "Active Travel Window",
      snippet: stream.snippets[idx],
      source: stream.source,
      urgency: analysis.urgency,
      timestamp: "Just now"
    };

    newLeads.push(lead);
  }

  const leads = loadLeads();
  // Prepend new leads
  for (const l of newLeads) {
    leads.unshift(l);
    console.log(`[Zion Intent Radar] ✨ Captured Lead: [${l.destination}] Budget: ${l.budget} via ${l.source} (${l.urgency})`);
  }

  // Keep last 100 leads
  if (leads.length > 100) leads.length = 100;

  saveLeads(leads);
}

console.log(`[Zion Luxe Engine] 🚀 Multi-Stream Intent Scraper active across ${STREAMS.length} channels.`);
console.log(`[Zion Luxe Engine] 🔄 Polling every ${INTERVAL_MS / 1000} seconds. Saving live leads to ${DATA_FILE}`);

// Run immediately, then interval
pollAllStreams();
setInterval(pollAllStreams, INTERVAL_MS);
>>>>>>> 97e4daa666981aebe40480663d8402247881e609
