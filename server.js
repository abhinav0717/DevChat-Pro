const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
require("dotenv").config();

const app = express();
app.set("trust proxy", 1); // Render / HTTPS deployment ke liye zaroori

const httpserver = http.createServer(app);
const io = new Server(httpserver);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- 1. SESSION & REAL GOOGLE OAUTH (PASSPORT.JS) ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || "devchat_secret",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback",
      },
      (accessToken, refreshToken, profile, done) => {
        const user = {
          name: profile.displayName,
          email: profile.emails?.[0]?.value || "",
          photo: profile.photos?.[0]?.value || "",
        };
        return done(null, user);
      }
    )
  );
}

// Google Auth Routes
app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/");
  }
);

app.get("/api/me", (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ authenticated: true, user: req.user });
  } else {
    res.json({ authenticated: false });
  }
});

app.get("/auth/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/");
  });
});

// --- 2. EMAIL INVITE (NODEMAILER - GMAIL SMTP) ---
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

app.post("/api/send-invite", async (req, res) => {
  const { email, roomCode, senderName } = req.body;

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(500).json({
      success: false,
      message: "EMAIL_USER or EMAIL_PASS missing in .env file!",
    });
  }

  try {
    await transporter.sendMail({
      from: `"${senderName}" <${process.env.EMAIL_USER}>`,
      to: email,
      replyTo: process.env.EMAIL_USER,
      subject: `Chat Room Code: ${roomCode} (from ${senderName})`,
      text: `Hi, ${senderName} invited you to join private chat room ${roomCode}. Open the chat app and enter ${roomCode} in Personal Rooms.`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 16px; color: #1e293b;">
          <p>Hi,</p>
          <p><strong>${senderName}</strong> invited you to join a private chat room.</p>
          <p style="font-size: 16px; background: #f1f5f9; padding: 10px 14px; border-radius: 6px; display: inline-block;">
            Room Code: <strong>${roomCode}</strong>
          </p>
          <p>Open the chat app and enter this code in <b>Personal Rooms</b> to join.</p>
        </div>
      `,
    });
    res.json({ success: true, message: "Invite sent successfully!" });
  } catch (err) {
    console.error("Nodemailer Error:", err);
    res.status(500).json({
      success: false,
      message: `Failed: ${err.message}`,
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- 3. EXISTING BACKEND CODE + ADVANCED ROOM FEATURES ---
let count = 0;
const roomUsers = {}; // Track members per room: { roomName: [ { id, username, photo } ] }

function updateRoomMembers(room) {
  const members = roomUsers[room] || [];
  io.to(room).emit("room-members", members);
}

io.on("connection", (socket) => {
  count++;
  console.log("Active User: ", count);
  io.emit("active", count);

  console.log("Connected Established");
  socket.emit("chat", "Hello from server side");
  socket.broadcast.emit("join", "New User Joined");

  socket.on("msg", (cb) => {
    console.log(cb);
    io.emit("chat", cb);
  });

  // Join Personal Room
  socket.on("join-room", ({ username, room, photo }) => {
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      roomUsers[socket.currentRoom] = (roomUsers[socket.currentRoom] || []).filter(
        (u) => u.id !== socket.id
      );
      updateRoomMembers(socket.currentRoom);
    }

    socket.join(room);
    socket.username = username;
    socket.currentRoom = room;

    if (!roomUsers[room]) roomUsers[room] = [];
    roomUsers[room].push({ id: socket.id, username, photo: photo || "" });

    updateRoomMembers(room);
    socket.to(room).emit("room-notification", `${username} joined the room`);
    socket.emit("room-notification", `You joined room: ${room}`);
  });

  // Leave Room explicitly
  socket.on("leave-room", () => {
    if (socket.currentRoom) {
      const oldRoom = socket.currentRoom;
      socket.leave(oldRoom);
      roomUsers[oldRoom] = (roomUsers[oldRoom] || []).filter((u) => u.id !== socket.id);
      updateRoomMembers(oldRoom);
      socket.to(oldRoom).emit("room-notification", `${socket.username} left the room`);
      socket.currentRoom = null;
    }
  });

  // Room Messaging
  socket.on("room-msg", ({ room, username, text, photo }) => {
    io.to(room).emit("receive-room-msg", {
      username,
      text,
      photo: photo || "",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    });
  });

  // Typing Indicator
  socket.on("typing", ({ room, username, isTyping }) => {
    if (room) {
      socket.to(room).emit("user-typing", { username, isTyping });
    } else {
      socket.broadcast.emit("user-typing", { username, isTyping });
    }
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    count--;
    console.log("Active User: ", count);
    io.emit("active", count);

    if (socket.currentRoom) {
      const r = socket.currentRoom;
      roomUsers[r] = (roomUsers[r] || []).filter((u) => u.id !== socket.id);
      updateRoomMembers(r);
      if (socket.username) {
        socket.to(r).emit("room-notification", `${socket.username} disconnected`);
      }
    }
  });

  // For making announcement
  io.emit("announce", "Only 5hr class left");
});

const PORT = process.env.PORT || 3000;
httpserver.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});