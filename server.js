// server.js

// Importeer de benodigde modules
require('dotenv').config(); // Zorg dat dotenv is geïnstalleerd en gebruikt voor lokale ontwikkeling
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch').Strategy;
const tmi = require('tmi.js');
const cors = require('cors'); // Voor Cross-Origin Resource Sharing, als je frontend op een ander domein draait

// Importeer het User model
// LET OP: Zorg ervoor dat de naam van dit bestand in de map 'models' ook 'User.js' is!
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 10000; // Render gebruikt de PORT env variable

// --- Middleware ---
app.use(express.json()); // Voor het parsen van JSON bodies
app.use(express.urlencoded({ extended: true })); // Voor het parsen van URL-encoded bodies

// CORS configuratie
// Pas 'origin' aan naar de URL van je frontend applicatie
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', // Bijv. 'https://jouw-frontend.onrender.com'
    credentials: true // Belangrijk voor het versturen van cookies/sessies
}));


// --- MongoDB Verbinding ---
// Zorg ervoor dat MONGO_URI is ingesteld als een Environment Variable in Render
// Voorbeeld waarde in Render: mongodb+srv://user:pass@cluster.mongodb.net/Maelmon?retryWrites=true&w=majority
// Let op de '/Maelmon' voor je database naam! Dit is CRUCIAAL.
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// --- Sessie Beheer met MongoStore ---
// Zorg ervoor dat SESSION_SECRET is ingesteld als een Environment Variable in Render
// Gebruik een lange, willekeurige string als geheime sleutel (bijv. via https://www.grc.com/passwords.htm)
app.use(session({
    secret: process.env.SESSION_SECRET || 'verander_dit_naar_een_zeer_sterke_geheime_sleutel_EN_STEL_IN_VIA_ENV',
    resave: false, // Zet op false tenzij je database opslag problemen hebt
    saveUninitialized: false, // Zet op false om onnodige sessies te voorkomen
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI, // Gebruik dezelfde MONGO_URI
        ttl: 14 * 24 * 60 * 60, // Sessies verlopen na 14 dagen (standaard)
        autoRemove: 'interval',
        autoRemoveInterval: 10 // Verwijder verlopen sessies elke 10 minuten
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 dagen in milliseconden
        secure: process.env.NODE_ENV === 'production', // true in productie (HTTPS), false in ontwikkeling (HTTP)
        httpOnly: true, // Voorkomt client-side JavaScript toegang tot cookie
        sameSite: 'lax' // Of 'none' als je een compleet andere frontend domein hebt (vereist secure: true)
    }
}));

// --- Passport.js Initialisatie ---
app.use(passport.initialize());
app.use(passport.session());

// --- Passport Serialisatie/Deserialisatie ---
// Bepaalt welke gebruikersinformatie wordt opgeslagen in de sessie
passport.serializeUser((user, done) => {
    done(null, user.id);
});

// Hoe de gebruiker wordt opgehaald uit de database op basis van de sessie-ID
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// --- Passport Twitch Strategie ---
// Zorg ervoor dat TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, en TWITCH_CALLBACK_URL
// allemaal zijn ingesteld als Environment Variables in Render!
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: process.env.TWITCH_CALLBACK_URL, // Dit was de 'Missing params' fout!
    scope: 'user:read:email', // Deze scope is nodig om e-mail te lezen, voeg meer toe indien nodig
    passReqToCallback: true
},
async (req, accessToken, refreshToken, profile, done) => {
    try {
        // Zoek of de gebruiker al bestaat in onze database met hun Twitch ID
        let user = await User.findOne({ twitchId: profile.id });

        if (user) {
            // Gebruiker bestaat al, update eventueel tokens of profielgegevens
            user.accessToken = accessToken;
            user.refreshToken = refreshToken;
            user.profileImageUrl = profile.profile_image_url; // Update profielfoto
            user.displayName = profile.display_name; // Update display naam
            await user.save();
            return done(null, user);
        } else {
            // Nieuwe gebruiker, maak een entry aan
            const newUser = new User({
                twitchId: profile.id,
                username: profile.login,
                displayName: profile.display_name,
                profileImageUrl: profile.profile_image_url,
                email: profile.email, // Vereist 'user:read:email' scope
                currency: 0, // Standaardwaarde voor nieuwe gebruikers
                isAdmin: false, // Standaardwaarde voor nieuwe gebruikers
                accessToken: accessToken, // Opslaan voor toekomstige Twitch API calls
                refreshToken: refreshToken
            });
            await newUser.save();
            return done(null, newUser);
        }
    } catch (err) {
        console.error('Fout tijdens Twitch authenticatie:', err);
        return done(err, null);
    }
}));

// --- Twitch Bot Client Initialisatie ---
// Zorg ervoor dat TWITCH_BOT_USERNAME, TWITCH_BOT_OAUTH (oauth: token), TWITCH_CHANNEL_NAME
// zijn ingesteld als Environment Variables in Render!
const client = new tmi.Client({
    options: { debug: true },
    connection: {
        secure: true,
        reconnect: true
    },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_BOT_OAUTH // Dit moet een 'oauth:' token zijn!
    },
    channels: [process.env.TWITCH_CHANNEL_NAME] // Dit is het kanaal waar de bot in komt
});

// Verbind de bot met Twitch
client.connect();

// Console log wanneer de bot verbonden is
client.on('connected', (addr, port) => {
    console.log(`[${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}] info: Connected to ${addr}:${port}`);
});

// --- TMI.js 'message' handler met robuuste foutafhandeling ---
client.on('message', async (channel, tags, message, self) => {
    if (self) return; // Negeer berichten van de bot zelf

    try {
        // Haal de gebruiker op uit de database, of null als deze niet bestaat
        let user = await User.findOne({ twitchId: tags['user-id'] });

        if (!user) {
            // Als de gebruiker niet gevonden is, probeer een nieuwe aan te maken
            const newUser = new User({
                twitchId: tags['user-id'],
                username: tags['username'],
                displayName: tags['display-name'],
                profileImageUrl: tags['user-image'],
                currency: 0,
                isAdmin: false
            });

            try {
                await newUser.save();
                console.log(`Nieuwe gebruiker ${newUser.displayName} (Twitch ID: ${newUser.twitchId}) via chat geregistreerd.`);

                // Probeer een welkomstbericht te sturen, met foutafhandeling
                try {
                    // Deze fout ("Cannot send anonymous messages") treedt op als de bot
                    // geen juiste authenticatie/scopes heeft om te praten
                    await client.say(channel, `Welcome to MaelMon, ${tags['display-name']}! Type !currency to check your balance.`);
                } catch (chatError) {
                    console.error(`Fout bij sturen welkomstbericht aan ${tags['display-name']} (bot authenticatie?):`, chatError.message);
                }
            } catch (saveError) {
                // Vang de E11000 duplicate key error op
                if (saveError.code === 11000) {
                    console.warn(`Gebruiker ${tags['display-name']} (Twitch ID: ${tags['user-id']}) bestaat al. Geen nieuwe entry toegevoegd.`);
                } else {
                    console.error(`Fout bij opslaan nieuwe gebruiker ${tags['display-name']}:`, saveError);
                }
            }
        }

        // --- Hier komt de rest van je command-afhandeling (bijv. !currency, !commands, etc.) ---
        // Zorg ervoor dat je 'user' of 'newUser' variabele gebruikt voor de commando's
        // Let op: 'user' is de bestaande gebruiker, 'newUser' is de zojuist aangemaakte.
        // Je kunt een variabele zoals 'activeUser' definiëren: const activeUser = user || newUser;
        const activeUser = user || await User.findOne({ twitchId: tags['user-id'] }); // Zorg dat we de meest actuele gebruiker hebben

        if (activeUser) { // Controleer altijd of er een gebruiker object is
            if (message.toLowerCase() === '!currency') {
                try {
                    await client.say(channel, `@${tags['display-name']}, je hebt ${activeUser.currency} currency.`);
                } catch (chatError) {
                    console.error(`Fout bij sturen currency bericht aan ${tags['display-name']}:`, chatError.message);
                }
            }
            // ... voeg hier andere commando's toe, bijv. !leaderboard, !card, etc.
        } else {
            console.warn(`Kon geen gebruiker vinden/aanmaken voor ${tags['display-name']} om commando's te verwerken.`);
        }

    } catch (error) {
        console.error('Algemene fout in TMI.js message handler:', error);
    }
});


// --- Express Routes ---
// Definieer de API endpoints van je backend
// Voorbeeld: Hoofdpagina
app.get('/', (req, res) => {
    res.send('MaelMon Backend draait!');
});

// Twitch authenticatie route
app.get('/auth/twitch', passport.authenticate('twitch'));

// Callback route na succesvolle Twitch authenticatie
app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: process.env.FRONTEND_URL || '/' }), // Redirect bij falen
    (req, res) => {
        // Succesvolle authenticatie, stuur de gebruiker door naar de frontend
        res.redirect(process.env.FRONTEND_URL + '/profile' || '/profile'); // Pas dit aan naar je frontend profielpagina
    }
);

// Route om in te loggen via de backend (controleert of gebruiker is ingelogd)
app.get('/auth/status', (req, res) => {
    if (req.isAuthenticated()) {
        // Stuur alleen noodzakelijke user info terug, NIET gevoelige data
        res.json({
            loggedIn: true,
            user: {
                id: req.user.id,
                displayName: req.user.displayName,
                profileImageUrl: req.user.profileImageUrl,
                currency: req.user.currency,
                isAdmin: req.user.isAdmin
            }
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Logout route
app.get('/logout', (req, res, next) => {
    req.logout((err) => { // Passport.js logout functie
        if (err) {
            return next(err);
        }
        req.session.destroy(() => { // Sessie vernietigen
            res.clearCookie('connect.sid'); // Verwijder de sessiecookie
            res.redirect(process.env.FRONTEND_URL || '/'); // Redirect naar de homepage (of frontend login)
        });
    });
});

// Voorbeeld van een beschermde route (alleen voor ingelogde gebruikers)
app.get('/profile', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({
            message: `Welkom, ${req.user.displayName}! Je bent ingelogd.`,
            user: req.user // Stuur het hele user object terug (voor test doeleinden)
        });
    } else {
        res.status(401).json({ message: 'Niet geautoriseerd. Log in.' });
    }
});

// Voeg hier andere routes toe, bijv. voor cards, admin functies etc.

// --- Server Start ---
app.listen(PORT, () => {
    console.log(`MaelMon Backend server draait op poort ${PORT}`);
});