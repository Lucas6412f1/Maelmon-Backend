// server.js

// Importeer de benodigde modules
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch').Strategy; // De @d-fischer strategie
const tmi = require('tmi.js');
const cors = require = require('cors');
const helmet = require('helmet'); // <-- Nieuwe import voor beveiliging

// Importeer het User model
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 10000;

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Beveiligingsheaders toevoegen met Helmet
app.use(helmet()); // <-- Nieuwe middleware voor beveiliging

// CORS configuratie
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));

// --- MongoDB Verbinding ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// --- Sessie Beheer met MongoStore ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'verander_dit_naar_een_zeer_sterke_geheime_sleutel_EN_STEL_IN_VIA_ENV',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGO_URI,
        ttl: 14 * 24 * 60 * 60,
        autoRemove: 'interval',
        autoRemoveInterval: 10
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 14,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// --- Passport.js Initialisatie ---
app.use(passport.initialize());
app.use(passport.session());

// --- Passport Serialisatie/Deserialisatie ---
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// --- Passport Twitch Strategie ---
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: process.env.TWITCH_CALLBACK_URL,
    scope: 'user:read:email',
    passReqToCallback: true
},
async (req, accessToken, refreshToken, profile, done) => {
    try {
        let user = await User.findOne({ twitchId: profile.id });

        if (user) {
            user.accessToken = accessToken;
            user.refreshToken = refreshToken;
            user.profileImageUrl = profile.profile_image_url;
            user.displayName = profile.display_name;
            await user.save();
            return done(null, user);
        } else {
            const newUser = new User({
                twitchId: profile.id,
                username: profile.login,
                displayName: profile.display_name,
                profileImageUrl: profile.profile_image_url,
                email: profile.email,
                currency: 0,
                isAdmin: false,
                accessToken: accessToken,
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
const client = new tmi.Client({
    options: { debug: true },
    connection: {
        secure: true,
        reconnect: true
    },
    identity: {
        username: process.env.TWITCH_BOT_USERNAME,
        password: process.env.TWITCH_BOT_OAUTH
    },
    channels: [process.env.TWITCH_CHANNEL_NAME]
});

client.connect();

client.on('connected', (addr, port) => {
    console.log(`[${new Date().toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}] info: Connected to ${addr}:${port}`);
});

// --- TMI.js 'message' handler met geoptimaliseerde foutafhandeling ---
client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const twitchId = tags['user-id'];
    const displayName = tags['display-name'];
    const username = tags['username'];

    let user;
    try {
        user = await User.findOne({ twitchId });

        if (!user) {
            const newUser = new User({
                twitchId,
                username,
                displayName,
                profileImageUrl: tags['user-image'],
                currency: 0,
                isAdmin: false
            });

            try {
                user = await newUser.save();
                console.log(`Nieuwe gebruiker ${user.displayName} (Twitch ID: ${user.twitchId}) via chat geregistreerd.`);
                try {
                    await client.say(channel, `Welcome to MaelMon, ${displayName}! Type !currency to check your balance.`);
                } catch (chatError) {
                    console.error(`Fout bij sturen welkomstbericht aan ${displayName} (bot authenticatie?):`, chatError.message);
                }
            } catch (saveError) {
                if (saveError.code === 11000) {
                    console.warn(`Gebruiker ${displayName} (Twitch ID: ${twitchId}) bestaat al (concurrent create). Ophalen...`);
                    user = await User.findOne({ twitchId });
                    if (!user) {
                        console.error(`Kritieke fout: kon gebruiker ${displayName} niet vinden na duplicate key error.`);
                        return;
                    }
                } else {
                    console.error(`Fout bij opslaan nieuwe gebruiker ${displayName}:`, saveError);
                    return;
                }
            }
        }

        // --- Commando afhandeling ---
        // VOOR GROTERE PROJECTEN: OVERWEEG DEZE COMMANDO'S TE MODULARISEREN!
        // Zie de uitleg hieronder voor hoe je dit kunt doen.
        if (message.toLowerCase() === '!currency') {
            try {
                await client.say(channel, `@${displayName}, je hebt ${user.currency} currency.`);
            } catch (chatError) {
                console.error(`Fout bij sturen currency bericht aan ${displayName}:`, chatError.message);
            }
        }
        // ... voeg hier andere commando's toe

    } catch (error) {
        console.error(`Algemene fout in TMI.js message handler voor ${displayName}:`, error);
    }
});


// --- Express Routes ---
app.get('/', (req, res) => {
    res.send('MaelMon Backend draait!');
});

app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: process.env.FRONTEND_URL || '/' }),
    (req, res) => {
        res.redirect(process.env.FRONTEND_URL + '/profile' || '/profile');
    }
);

app.get('/auth/status', (req, res) => {
    if (req.isAuthenticated()) {
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

app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        req.session.destroy(() => {
            res.clearCookie('connect.sid');
            res.redirect(process.env.FRONTEND_URL || '/');
        });
    });
});

app.get('/profile', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({
            message: `Welkom, ${req.user.displayName}! Je bent ingelogd.`,
            user: req.user
        });
    } else {
        res.status(401).json({ message: 'Niet geautoriseerd. Log in.' });
    }
});

// --- Globale Express Foutafhandeling Middleware ---
// Deze middleware wordt geactiveerd als er een fout optreedt in een van de Express routes
app.use((err, req, res, next) => {
    console.error(err.stack); // Log de fout stack trace naar de console

    // Stuur een algemeen foutbericht naar de client
    // In productie wil je misschien minder detail geven over de fout
    res.status(500).send('Er is iets misgegaan op de server!');
});


// --- Server Start ---
app.listen(PORT, () => {
    console.log(`MaelMon Backend server draait op poort ${PORT}`);
});