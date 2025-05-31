// server.js

// 1. Essentiële Modules Importeren
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch').Strategy;
const cors = require('cors');
require('dotenv').config(); // Laadt omgevingsvariabelen uit .env bestand (voor lokale ontwikkeling)

// Twitch Chat Bot gerelateerde imports
const tmi = require('tmi.js');

// 2. Express App Initialiseren
const app = express();
const PORT = process.env.PORT || 10000; // Gebruik de poort van Render, anders 10000 lokaal

// 3. MongoDB Connectie
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// MongoDB Schema en Model voor Gebruikers
const userSchema = new mongoose.Schema({
    twitchId: { type: String, unique: true, required: true },
    username: { type: String, required: true },
    displayName: String,
    profileImageUrl: String,
    isAdmin: { type: Boolean, default: false },
    currency: { type: Number, default: 0 },
    lastPackClaimed: { type: Date, default: null },
    cards: [{
        cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card' },
        quantity: { type: Number, default: 1 }
    }]
});
const User = mongoose.model('User', userSchema);

// MongoDB Schema en Model voor Kaarten
const cardSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    type: { type: String, required: true }, // Bijv. "Attack", "Defense", "Support"
    attack: { type: Number, default: 0 },
    defense: { type: Number, default: 0 },
    characterImageUrl: { type: String, required: true },
    rarity: { type: String, required: true }, // Bijv. "Common", "Rare", "Epic", "Legendary"
    description: String,
    maxSupply: { type: Number, default: 0 }, // 0 = unlimited
    currentSupply: { type: Number, default: 0 } // Houd bij hoeveel er in omloop zijn
});
const Card = mongoose.model('Card', cardSchema);


// 4. Passport.js Setup voor Twitch OAuth
passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
    User.findById(id, function(err, user) {
        done(err, user);
    });
});

passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    // DEZE CALLBACK URL MOET EXACT OVEREENKOMEN MET JE TWITCH DEVELOPER CONSOLE
    callbackURL: "https://maelmon-backend.onrender.com/auth/twitch/callback",
    scope: "user:read:email",
},
function(accessToken, refreshToken, profile, done) {
    // Hier wordt de gebruiker gevonden of aangemaakt in je database
    User.findOne({ twitchId: profile.id }, function(err, user) {
        if (err) { return done(err); }
        if (!user) {
            // Nieuwe gebruiker, maak een record aan
            const newUser = new User({
                twitchId: profile.id,
                username: profile.login,
                displayName: profile.display_name,
                profileImageUrl: profile.profile_image_url,
                currency: 100, // Startgeld
                isAdmin: false // Nieuwe gebruikers zijn standaard geen admin
            });
            newUser.save(function(err) {
                if (err) { return done(err); }
                console.log(`Nieuwe gebruiker ${newUser.username} opgeslagen.`);
                return done(null, newUser);
            });
        } else {
            // Bestaande gebruiker, update eventueel gegevens
            user.displayName = profile.display_name;
            user.profileImageUrl = profile.profile_image_url;
            // Je kunt hier meer velden updaten
            user.save(function(err) { // Sla updates op
                if (err) { console.error("Fout bij updaten gebruiker:", err); }
                console.log(`Gebruiker ${user.username} al bekend, ingelogd.`);
                return done(null, user);
            });
        }
    });
}));

// 5. Middleware configureren
app.use(cors({
    // ZORG DAT DIT DE EXACTE URL(S) VAN JE FRONTEND ZIJN
    origin: ['https://maelmon-trading-cards.onrender.com', 'http://localhost:3000'],
    credentials: true, // Essentieel om cookies mee te sturen
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Toegestane HTTP-methoden
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'], // Toegestane headers
}));
app.use(express.json()); // Body parser voor JSON data

// Sessie middleware configuratie
app.use(session({
    secret: process.env.SESSION_SECRET, // GEBRUIK EEN STERKE, WILLEKEURIGE STRING HIER (in Render ENV)
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // MOET TRUE ZIJN VOOR HTTPS (RENDER GEBRUIKT HTTPS)
        httpOnly: true, // Voorkomt JavaScript toegang tot de cookie
        maxAge: 24 * 60 * 60 * 1000, // Cookie geldig voor 24 uur
        sameSite: 'none' // CRUCIAAL VOOR CROSS-ORIGIN SESSIES (frontend en backend op verschillende domeinen)
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Hulpfunctie om te controleren of gebruiker is ingelogd
const isAuthenticated = (req, res, next) => {
    if (req.isAuthenticated()) {
        return next();
    }
    // Als niet ingelogd, stuur 401 Unauthorized
    res.status(401).json({ message: "Not authenticated" });
};

// Hulpfunctie om te controleren of gebruiker admin is
const isAdmin = (req, res, next) => {
    if (req.isAuthenticated() && req.user.isAdmin) {
        return next();
    }
    res.status(403).json({ message: "Forbidden: Not an administrator" });
};


// 6. Authenticatie Routes
app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: 'https://maelmon-trading-cards.onrender.com/login.html' }), // Redirect bij mislukking
    function(req, res) {
        // Succesvolle authenticatie, redirect naar de hoofdapp
        res.redirect('https://maelmon-trading-cards.onrender.com/');
    }
);

app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        // Na logout redirect naar de login pagina van de frontend
        res.redirect('https://maelmon-trading-cards.onrender.com/login.html');
    });
});

// 7. API Routes (Gebruiker)
app.get('/api/user', isAuthenticated, (req, res) => {
    // Stuur relevante gebruikersdata (haal gevoelige info zoals twitchId weg indien gewenst)
    res.json({
        isLoggedIn: true,
        username: req.user.username,
        displayName: req.user.displayName,
        profileImageUrl: req.user.profileImageUrl,
        currency: req.user.currency,
        isAdmin: req.user.isAdmin,
        lastPackClaimed: req.user.lastPackClaimed,
        cards: req.user.cards // Inclusief de kaarten
    });
});

app.post('/api/user/claim-daily-pack', isAuthenticated, async (req, res) => {
    const user = req.user;
    const now = new Date();
    const DAILY_PACK_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 uur

    if (user.lastPackClaimed && (now.getTime() - user.lastPackClaimed.getTime()) < DAILY_PACK_COOLDOWN_MS) {
        return res.status(400).json({ message: "Daily pack already claimed. Please wait." });
    }

    try {
        // Vind een willekeurige kaart uit de database
        const allCards = await Card.find({});
        if (allCards.length === 0) {
            return res.status(500).json({ message: "No cards available to claim." });
        }
        const randomCard = allCards[Math.floor(Math.random() * allCards.length)];

        // Update gebruiker
        user.currency += 50; // Voorbeeld: 50 muntjes per dagelijks pak
        user.lastPackClaimed = now;

        // Voeg de kaart toe aan de inventaris van de gebruiker
        const existingCardIndex = user.cards.findIndex(c => c.cardId.equals(randomCard._id));
        if (existingCardIndex > -1) {
            user.cards[existingCardIndex].quantity += 1;
        } else {
            user.cards.push({ cardId: randomCard._id, quantity: 1 });
        }

        await user.save();
        res.json({
            message: `You claimed your daily pack and received ${randomCard.name} and 50 currency!`,
            card: randomCard // Stuur de gewonnen kaart terug voor weergave
        });
    } catch (error) {
        console.error("Error claiming daily pack:", error);
        res.status(500).json({ message: "Error claiming daily pack. Please try again." });
    }
});


// 8. Admin Routes
app.post('/api/admin/cards', isAdmin, async (req, res) => {
    try {
        const { name, type, attack, defense, characterImageUrl, rarity, description, maxSupply } = req.body;

        const newCard = new Card({
            name,
            type,
            attack,
            defense,
            characterImageUrl,
            rarity,
            description,
            maxSupply,
            currentSupply: 0 // Start op 0, wordt verhoogd wanneer de kaart wordt geclaimd/gekocht
        });

        await newCard.save();
        res.status(201).json({ message: 'Card added successfully!', card: newCard });
    } catch (error) {
        if (error.code === 11000) { // Duplicate key error (name is unique)
            return res.status(409).json({ message: 'Card with this name already exists.' });
        }
        console.error("Error adding card:", error);
        res.status(500).json({ message: 'Error adding card.' });
    }
});

// 9. Twitch Chat Bot
const client = new tmi.Client({
    options: { debug: true },
    connection: { reconnect: true },
    identity: {
        username: process.env.TWITCH_USERNAME, // JOUW TWITCH BOT GEBRUIKERSNAAM
        password: process.env.TWITCH_OAUTH_TOKEN // OAuth token voor de bot (begint met 'oauth:')
    },
    channels: [process.env.TWITCH_CHANNEL] // JOUW TWITCH KANAAL NAAM
});

client.on('message', async (channel, tags, message, self) => {
    if (self) return; // Ignore messages from the bot itself

    const username = tags['display-name'];
    let user = await User.findOne({ twitchId: tags['user-id'] });

    if (!user) {
        // Als de bot een bericht krijgt van een onbekende gebruiker, registreer hem.
        // Dit is een fallback, normaal gesproken registreert de OAuth flow gebruikers.
        user = new User({
            twitchId: tags['user-id'],
            username: tags['username'], // tmi.js geeft 'username' als login, 'display-name' als displaynaam
            displayName: tags['display-name'],
            profileImageUrl: tags['user-image'], // tmi.js geeft user-image, of je kunt de Twitch API gebruiken
            currency: 0,
            isAdmin: false
        });
        await user.save();
        console.log(`Nieuwe gebruiker ${user.username} via chat geregistreerd.`);
        client.say(channel, `Welcome to MaelMon, ${username}! Type !currency to check your balance.`);
    }

    if (message.toLowerCase() === '!currency') {
        if (user) {
            client.say(channel, `${username}, your current currency is ${user.currency} ⭐.`);
        } else {
            client.say(channel, `${username}, I couldn't find your data. Are you logged in on the website?`);
        }
    }
    // Voeg hier meer bot commando's toe, bijv. !claimpack, !shop, etc.
});

client.connect(); // Start de bot

// 10. Server starten
app.listen(PORT, () => {
    console.log(`MaelMon Backend server running on http://localhost:${PORT}`);
});