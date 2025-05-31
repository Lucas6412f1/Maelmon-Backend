// server.js

// 1. Vereiste modules importeren
require('dotenv').config(); // Laadt .env variabelen (voor lokale ontwikkeling)
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // Voor persistente sessies
const passport = require('passport');
const TwitchStrategy = require('@d-fischer/passport-twitch').Strategy; // De correcte Twitch strategie
const mongoose = require('mongoose');
const cors = require('cors');
const tmi = require('tmi.js'); // Voor de Twitch Chat Bot

// 2. Express applicatie initialiseren
const app = express();
// Poortconfiguratie: Gebruik Render's PORT variabele of standaard 10000
const PORT = process.env.PORT || 10000;

// 3. MongoDB verbinding
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// 4. Mongoose User Schema en Model
const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    profileImageUrl: { type: String, default: '' },
    currency: { type: Number, default: 0 },
    isAdmin: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);

// 5. Passport.js serialisatie/deserialisatie
// Gebruiker opslaan in sessie
passport.serializeUser((user, done) => {
    done(null, user.id);
});

// Gebruiker ophalen uit sessie
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// 6. Passport Twitch Strategie
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: process.env.TWITCH_CALLBACK_URL,
    scope: 'user:read:email', // Vraagt om email, hoewel Twitch dit voor bots niet altijd direct geeft
    passReqToCallback: true // Zorgt ervoor dat 'req' beschikbaar is in de verify callback (niet essentieel voor deze code, maar vaak handig)
},
// Dit is de 'verify' functie die wordt aangeroepen na de Twitch authenticatie
async function(req, accessToken, refreshToken, profile, done) {
    try {
        // Log de profielgegevens die van Twitch komen (voor debugging)
        console.log("Twitch Profile:", profile);

        // Zoek de gebruiker in de database op basis van twitchId
        // NIEUW: Gebruik await, want findOne retourneert een Promise
        const user = await User.findOne({ twitchId: profile.id });

        if (!user) {
            // Gebruiker niet gevonden, maak een nieuwe aan
            const newUser = new User({
                twitchId: profile.id,
                username: profile.login,
                displayName: profile.display_name,
                profileImageUrl: profile.profile_image_url,
                currency: 100, // Startgeld
                isAdmin: false // Nieuwe gebruikers zijn standaard geen admin
            });
            await newUser.save(); // NIEUW: Gebruik await voor opslaan
            console.log(`Nieuwe gebruiker ${newUser.username} opgeslagen.`);
            return done(null, newUser);
        } else {
            // Gebruiker al bekend, update eventueel gegevens
            user.displayName = profile.display_name;
            user.profileImageUrl = profile.profile_image_url;
            // Je kunt hier meer velden updaten indien nodig
            await user.save(); // NIEUW: Gebruik await voor opslaan
            console.log(`Gebruiker ${user.username} al bekend, ingelogd.`);
            return done(null, user);
        }
    } catch (err) {
        // Als er een fout optreedt, geef deze door aan Passport
        console.error("Fout in Passport verify functie:", err);
        return done(err);
    }
}));

// 7. Express middleware configuratie

// CORS instellingen voor cross-origin requests
app.use(cors({
    origin: process.env.FRONTEND_URL, // Vervang dit met de daadwerkelijke URL van je frontend op Render
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true // Belangrijk voor het doorsturen van cookies/sessies
}));

app.use(express.json()); // Body parser voor JSON
app.use(express.urlencoded({ extended: true })); // Body parser voor URL-encoded data

// Sessie middleware
app.use(session({
    secret: process.env.SESSION_SECRET, // Een sterke, geheime sleutel
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ // Gebruik MongoStore voor persistente sessies
        mongoUrl: process.env.MONGO_URI,
        collectionName: 'sessions', // Naam van de collectie voor sessies in MongoDB
        ttl: 14 * 24 * 60 * 60 // Sessie TTL in seconden (14 dagen)
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 dagen
        secure: true, // Cookies alleen via HTTPS (verplicht voor sameSite: 'none')
        sameSite: 'none' // Essentieel voor cross-site cookie werking
    }
}));

// Passport initialiseren
app.use(passport.initialize());
app.use(passport.session());

// 8. Routes

// Hoofdpagina route (kan ook een simpel bericht zijn of redirect)
app.get('/', (req, res) => {
    res.send('MaelMon Backend is running!');
});

// Twitch authenticatie routes
app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: `${process.env.FRONTEND_URL}/login.html` }),
    (req, res) => {
        // Succesvolle authenticatie, redirect naar de hoofdpagina van de frontend
        res.redirect(process.env.FRONTEND_URL || '/'); // Redirect naar frontend URL
    }
);

// Route om de ingelogde gebruiker op te halen
app.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({
            loggedIn: true,
            user: {
                id: req.user.id,
                twitchId: req.user.twitchId,
                username: req.user.username,
                displayName: req.user.displayName,
                profileImageUrl: req.user.profileImageUrl,
                currency: req.user.currency,
                isAdmin: req.user.isAdmin
            }
        });
    } else {
        res.status(401).json({ loggedIn: false, message: 'Niet geauthenticeerd.' });
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return res.status(500).send('Fout bij uitloggen.'); }
        req.session.destroy(() => {
            // Redirect naar de frontend login pagina na uitloggen
            res.redirect(`${process.env.FRONTEND_URL}/login.html`);
        });
    });
});

// Admin card management API (voorbeeld)
// Deze route moet beveiligd worden, bijvoorbeeld met een admin check
app.post('/api/admin/cards', async (req, res) => {
    // Voeg hier logica toe om te controleren of de gebruiker admin is
    // if (!req.isAuthenticated() || !req.user.isAdmin) {
    //     return res.status(403).json({ message: 'Toegang geweigerd.' });
    // }

    try {
        const { name, type, attack, defense, rarity, description, characterImageUrl } = req.body;
        // Voorbeeld: Sla kaart op in MongoDB (je hebt een Card model nodig)
        // const newCard = new Card({ name, type, attack, defense, rarity, description, characterImageUrl });
        // await newCard.save();
        res.status(201).json({ message: 'Kaart toegevoegd (simulatie)', card: req.body });
    } catch (error) {
        console.error('Fout bij toevoegen kaart:', error);
        res.status(500).json({ message: 'Interne serverfout bij toevoegen kaart.' });
    }
});


// 9. Server starten
app.listen(PORT, () => {
    console.log(`MaelMon Backend server draait op poort ${PORT}`);
});

// 10. Twitch Chat Bot (apart gedeelte)
const client = new tmi.Client({
    options: { debug: true },
    connection: {
        reconnect: true,
        secure: true
    },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME, // Bot's Twitch username
        password: process.env.TWITCH_BOT_OAUTH // Bot's Twitch OAuth token (start met oauth:)
    },
    channels: [process.env.TWITCH_CHANNEL_NAME] // Het kanaal waar de bot actief moet zijn
});

client.connect(); // Verbind de bot met Twitch Chat

client.on('message', async (channel, tags, message, self) => {
    if (self) return; // Ignore messages from the bot itself

    // Voeg de gebruiker toe aan de database als die nog niet bestaat
    let user = await User.findOne({ twitchId: tags['user-id'] });

    if (!user) {
        // Als de bot een bericht krijgt van een onbekende gebruiker, registreer hem.
        user = new User({
            twitchId: tags['user-id'],
            username: tags['username'],
            displayName: tags['display-name'],
            profileImageUrl: tags['user-image'],
            currency: 0, // Beginvaluta voor chat-geregistreerde gebruikers
            isAdmin: false
        });
        await user.save();
        client.say(channel, `Welcome to MaelMon, ${tags['display-name']}! Type !currency to check your balance.`);
        console.log(`Nieuwe gebruiker ${tags['display-name']} via chat geregistreerd.`);
    }

    if (message.toLowerCase() === '!currency' || message.toLowerCase() === '!balance' || message.toLowerCase() === '!mybalance') {
        client.say(channel, `${user.displayName}, your current currency is ${user.currency} ⭐.`);
    }

    // Andere bot commando's kunnen hier worden toegevoegd
});

client.on('connected', (address, port) => {
    console.log(`[${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}] info: Connected to ${address}:${port}`);
});

// Foutafhandeling voor de bot
client.on('disconnected', (reason) => {
    console.error(`[${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}] error: Disconnected from Twitch chat: ${reason}`);
});

client.on('reconnect', () => {
    console.log(`[${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}] info: Attempting to reconnect to Twitch chat...`);
});