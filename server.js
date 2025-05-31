// server.js

// Importeer de benodigde modules
require('dotenv').config(); // Zorg dat dotenv is geïnstalleerd en gebruikt voor lokale ontwikkeling
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch').Strategy; // De @d-fischer strategie
const tmi = require('tmi.js');
const cors = require('cors');
const helmet = require('helmet'); // <-- Nieuwe import voor beveiliging
const fs = require('fs'); // <-- Nieuwe import voor het inlezen van commando's
const path = require('path'); // <-- Nieuwe import voor paden

// Importeer het User model
const User = require('./models/User'); // Zorg dat dit pad en de bestandsnaam klopt (User.js)

const app = express();
const PORT = process.env.PORT || 10000; // Render gebruikt de PORT env variable

// --- Middleware ---
app.use(express.json()); // Voor het parsen van JSON bodies
app.use(express.urlencoded({ extended: true })); // Voor het parsen van URL-encoded bodies

// Beveiligingsheaders toevoegen met Helmet
app.use(helmet()); // <-- Nieuwe middleware voor beveiliging

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

// --- TMI.js Commando Loader ---
const commands = new Map();
const commandsPath = path.join(__dirname, 'commands'); // Pad naar de commands map
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        // Controleer of het commando een 'name' en een 'execute' functie heeft
        if (command.name && typeof command.execute === 'function') {
            commands.set(command.name, command);
            console.log(`Commando '${command.name}' geladen vanuit ${file}`);
        } else {
            console.warn(`Het bestand ${file} in de commands map heeft niet de verwachte 'name' of 'execute' eigenschappen.`);
        }
    } catch (error) {
        console.error(`Fout bij het laden van commando ${file}:`, error);
    }
}

// --- TMI.js 'message' handler met geoptimaliseerde foutafhandeling en modulaire commando's ---
client.on('message', async (channel, tags, message, self) => {
    if (self) return; // Negeer berichten van de bot zelf

    const twitchId = tags['user-id'];
    const displayName = tags['display-name'];
    const username = tags['username'];

    let user;
    try {
        user = await User.findOne({ twitchId });

        if (!user) {
            // Als de gebruiker niet gevonden is, probeer een nieuwe aan te maken
            const newUser = new User({
                twitchId,
                username,
                displayName,
                profileImageUrl: tags['user-image'],
                currency: 0,
                isAdmin: false
            });

            try {
                user = await newUser.save(); // Wijs de zojuist opgeslagen gebruiker toe aan 'user'
                console.log(`Nieuwe gebruiker ${user.displayName} (Twitch ID: ${user.twitchId}) via chat geregistreerd.`);

                // Probeer een welkomstbericht te sturen, met foutafhandeling
                try {
                    await client.say(channel, `Welcome to MaelMon, ${displayName}! Type !currency to check your balance.`);
                } catch (chatError) {
                    console.error(`Fout bij sturen welkomstbericht aan ${displayName} (bot authenticatie?):`, chatError.message);
                }
            } catch (saveError) {
                // Vang de E11000 duplicate key error op (race condition)
                if (saveError.code === 11000) {
                    console.warn(`Gebruiker ${displayName} (Twitch ID: ${twitchId}) bestaat al (concurrent create). Ophalen...`);
                    // Probeer de gebruiker opnieuw op te halen, mocht er een race-condition zijn geweest
                    user = await User.findOne({ twitchId });
                    if (!user) {
                        console.error(`Kritieke fout: kon gebruiker ${displayName} niet vinden na duplicate key error.`);
                        return; // Stop verwerking als gebruiker echt niet te vinden is
                    }
                } else {
                    console.error(`Fout bij opslaan nieuwe gebruiker ${displayName}:`, saveError);
                    return; // Stop verwerking als opslaan om andere reden faalt
                }
            }
        }

        // --- Commando afhandeling via de Commands Map ---
        const args = message.toLowerCase().split(' ');
        const commandName = args[0]; // Bijv. "!currency"

        if (commands.has(commandName)) {
            const command = commands.get(commandName);
            try {
                // Geef de benodigde parameters mee, inclusief de 'user'
                await command.execute(client, channel, tags, message, user, args); // 'args' ook meegegeven
            } catch (error) {
                console.error(`Fout bij uitvoeren commando ${commandName}:`, error);
                await client.say(channel, `Sorry, ${displayName}, er ging iets mis met het commando "${commandName}".`);
            }
        }
        // Optioneel: voeg hier een !commands commando toe dat alle geladen commando's opsomt
        // else if (message.toLowerCase() === '!commands') {
        //     const loadedCommandNames = Array.from(commands.keys()).join(', ');
        //     await client.say(channel, `@${displayName}, beschikbare commando's: ${loadedCommandNames}`);
        // }


    } catch (error) {
        console.error(`Algemene fout in TMI.js message handler voor ${displayName}:`, error);
        // Optioneel: stuur een algemeen foutbericht naar de chat als er een interne fout optreedt
        // try {
        //     await client.say(channel, `Sorry, ${displayName}, er ging iets mis met mijn commando verwerking. Probeer het later opnieuw.`);
        // } catch (chatError) {
        //     console.error(`Fout bij sturen algemeen foutbericht aan ${displayName}:`, chatError.message);
        // }
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