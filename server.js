// Relais « mode téléphone » pour Quiz Master.
// Lancement : node server.js  (Node.js 18+, aucune dépendance)
// Le jeu Roblox parle à ce serveur (hôte : secret), les téléphones ouvrent la page racine.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-host-secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 200000) {
        reject(new Error("Requête trop grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(new Error("JSON invalide"));
      }
    });
  });
}

// Ce que voient les téléphones : jamais la bonne réponse, sauf pendant le reveal
function publicRoom(room) {
  const question = room.question;
  return {
    code: room.code,
    state: room.state,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    question: question
      ? { id: question.id, text: question.text, type: question.type, answers: question.answers, seconds: question.seconds }
      : null,
    correctIndex: room.state === "reveal" && question ? question.correctIndex : null,
  };
}

function checkSecret(req, room) {
  return req.headers["x-host-secret"] === room.secret;
}

async function handleApi(req, res, pathname) {
  const parts = pathname.split("/").filter(Boolean); // ["api", "rooms", CODE, action]

  if (req.method === "POST" && parts.length === 2 && parts[1] === "rooms") {
    const code = makeCode();
    const secret = crypto.randomBytes(16).toString("hex");
    rooms.set(code, { code, secret, state: "lobby", players: [], question: null, answers: {}, createdAt: Date.now() });
    return send(res, 200, { code, secret });
  }

  if (parts.length < 3 || parts[1] !== "rooms") return send(res, 404, { error: "Route inconnue" });

  const room = rooms.get(parts[2]);
  if (!room) return send(res, 404, { error: "Salon introuvable" });
  const action = parts[3];

  if (req.method === "GET" && !action) return send(res, 200, publicRoom(room));

  if (req.method === "POST" && action === "join") {
    const body = await readBody(req);
    if (room.state !== "lobby") return send(res, 409, { error: "La partie a déjà commencé" });
    const name = String(body.name || "").trim().slice(0, 16);
    if (!name) return send(res, 400, { error: "Pseudo requis" });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return send(res, 409, { error: "Ce pseudo est déjà pris" });
    }
    const player = { id: crypto.randomBytes(8).toString("hex"), name };
    room.players.push(player);
    return send(res, 200, { playerId: player.id });
  }

  if (req.method === "POST" && action === "answer") {
    const body = await readBody(req);
    if (room.state !== "question" || !room.question || body.questionId !== room.question.id) {
      return send(res, 409, { error: "Pas de question en cours" });
    }
    if (!room.players.some((p) => p.id === body.playerId)) return send(res, 403, { error: "Joueur inconnu" });
    if (room.answers[body.playerId] !== undefined) return send(res, 409, { error: "Réponse déjà enregistrée" });
    const answer = Number(body.answer);
    if (!Number.isInteger(answer) || answer < 1 || answer > room.question.answers.length) {
      return send(res, 400, { error: "Réponse invalide" });
    }
    room.answers[body.playerId] = answer;
    return send(res, 200, { ok: true });
  }

  // Routes réservées à l'hôte (Roblox)
  if (!checkSecret(req, room)) return send(res, 403, { error: "Secret invalide" });

  if (req.method === "POST" && action === "question") {
    const body = await readBody(req);
    if (!body.id || !body.text || !Array.isArray(body.answers) || body.answers.length < 2) {
      return send(res, 400, { error: "Question invalide" });
    }
    room.question = {
      id: String(body.id),
      text: String(body.text),
      type: body.type || "quiz",
      answers: body.answers.map(String),
      seconds: Number(body.seconds) || 20,
      correctIndex: Number(body.correctIndex) || null,
    };
    room.answers = {};
    room.state = "question";
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && action === "state") {
    const body = await readBody(req);
    if (!["lobby", "question", "reveal", "finished"].includes(body.state)) return send(res, 400, { error: "État invalide" });
    room.state = body.state;
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && action === "answers") {
    return send(res, 200, { answers: room.answers, questionId: room.question ? room.question.id : null });
  }

  return send(res, 404, { error: "Route inconnue" });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    return send(res, 404, { error: "Page introuvable" });
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

// Nettoyage des salons inactifs
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Relais Quiz Master sur le port ${PORT}`));
