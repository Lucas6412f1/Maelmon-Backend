// server.js

// 1. Benodigde pakketten importeren
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Voor cross-origin verzoeken (frontend naar backend)
const tmi = require('tmi.js'); // Voor de Twitch bot

// NIEUWE IMPORTS VOOR AUTHENTICATIE
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('@d-fischer/passport-twitch').Strategy;


// Zorg ervoor dat dotenv bovenaan staat als je het gebruikt voor lokale tests
require('dotenv').config();

// 2. Express app initialiseren
const app = express();
const PORT = process.env.PORT || 10000;

// 3. Connectie maken met MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// 4. Mongoose Modellen definiëren
const CardSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, required: true }, // Bijvoorbeeld: 'Monster', 'Spell'
    attack: { type: Number, required: true },
    defense: { type: Number, required: true },
    characterImageUrl: { type: String, required: true }, // De custom foto van het wezen/item
    backgroundImageUrl: { type: String, required: true }, // De custom achtergrond/frame van de kaart
    rarity: {
        type: String,
        enum: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Unique'],
        default: 'Common'
    },
    maxSupply: { type: Number, default: -1 }, // -1 = onbeperkt, anders een nummer (bijv. 1, 10)
    currentSupply: { type: Number, default: 0 }, // Hoeveel er van dit type kaart zijn gemaakt
    ownerId: { type: String, default: null } // Twitch user ID van de eigenaar
});
const Card = mongoose.model('Card', CardSchema);

const UserSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    email: { type: String, required: false },
    profileImageUrl: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    isAdmin: { type: Boolean, default: false } // Om admins te identificeren
});
const User = mongoose.model('User', UserSchema);


// 5. Middleware configureren
app.use(cors({
    origin: ['https://maelmon-trading-cards.onrender.com', 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// 6. Passport Twitch Strategie configureren
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: "https://maelmon-backend.onrender.com/auth/twitch/callback",
    scope: "user:read:email",
},
function(accessToken, refreshToken, profile, done) {
    User.findOne({ twitchId: profile.id })
        .then(currentUser => {
            if (currentUser) {
                console.log(`Gebruiker ${currentUser.username} al bekend, ingelogd.`);
                done(null, currentUser);
            } else {
                // Nieuwe gebruiker, maak een nieuw record aan
                // === BEGIN WIJZIGING (isAdmin automatisch toewijzen) ===
                const isNewAdmin = (profile.display_name === 'Lucas6412TM' || profile.display_name === 'maelsethe420');

                new User({
                    twitchId: profile.id,
                    username: profile.display_name,
                    email: profile.email,
                    profileImageUrl: profile.profile_image_url,
                    isAdmin: isNewAdmin // Hier wordt de isAdmin status ingesteld
                }).save()
                  .then(newUser => {
                      console.log(`Nieuwe gebruiker ${newUser.username} opgeslagen. Admin status: ${newUser.isAdmin}`);
                      done(null, newUser);
                  })
                  .catch(err => done(err));
                // === EINDE WIJZIGING ===
            }
        })
        .catch(err => done(err));
}
));

// 7. Passport: Hoe gebruikersdata in en uit de sessie wordt opgeslagen
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    User.findById(id)
        .then(user => {
            done(null, user);
        })
        .catch(err => done(err));
});

// Middleware om te controleren of de gebruiker is ingelogd
function isAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { // Passport voegt isAuthenticated() toe aan req
        return next();
    }
    res.status(401).json({ message: 'Niet geauthenticeerd.' });
}

// Middleware om te controleren of de gebruiker een admin is
function isAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.isAdmin) {
        return next();
    }
    res.status(403).json({ message: 'Toegang geweigerd. Alleen admins.' });
}


// 8. API Routes
app.get('/api/cards', async (req, res) => {
    try {
        const cards = await Card.find();
        res.json(cards);
    } catch (err) {
        console.error('Fout bij ophalen kaarten uit MongoDB:', err);
        res.status(500).json({ message: 'Interne serverfout bij ophalen kaarten.' });
    }
});

// NIEUWE ADMIN ROUTE: Kaarten toevoegen
app.post('/api/admin/cards', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // We verwachten dat de frontend de volgende data stuurt
        const {
            name,
            type,
            attack,
            defense,
            characterImageUrl,
            backgroundImageUrl,
            rarity,
            maxSupply // Wordt gebruikt voor de definitie
        } = req.body;

        // Validatie (eenvoudig, je kunt dit uitbreiden)
        if (!name || !type || !attack || !defense || !characterImageUrl || !backgroundImageUrl || !rarity) {
            return res.status(400).json({ message: 'Alle verplichte kaartvelden moeten worden ingevuld.' });
        }
        if (isNaN(attack) || isNaN(defense)) {
            return res.status(400).json({ message: 'Attack en Defense moeten nummers zijn.' });
        }
        if (maxSupply !== undefined && maxSupply !== null && isNaN(parseInt(maxSupply))) {
             return res.status(400).json({ message: 'Max Supply moet een nummer zijn (-1 voor onbeperkt).' });
        }

        let finalMaxSupply = -1; // Default naar onbeperkt
        if (maxSupply !== undefined && maxSupply !== null) {
            finalMaxSupply = parseInt(maxSupply);
            if (finalMaxSupply < -1) {
                return res.status(400).json({ message: 'Max Supply kan niet negatief zijn (behalve -1 voor onbeperkt).' });
            }
        }

        // --- Logica voor maxSupply en currentSupply ---
        // We zoeken een bestaande kaart "definitie" op basis van naam, type en zeldzaamheid.
        // Als je wilt dat bv. "Blue Dragon Rare" en "Blue Dragon Common" afzonderlijke supplies hebben,
        // dan moet de combinatie van deze velden uniek zijn voor een 'kaartdefinitie'.
        let existingCardDefinition = await Card.findOne({ name, type, rarity, ownerId: null }); // ownerId: null om definities te onderscheiden van bezeten kaarten

        let cardToSave; // Dit zal de kaartinstantie zijn die we opslaan

        if (existingCardDefinition) {
            // Kaartdefinitie bestaat al
            if (existingCardDefinition.maxSupply !== -1 && existingCardDefinition.currentSupply >= existingCardDefinition.maxSupply) {
                return res.status(400).json({ message: `Maximum aantal van deze kaartdefinitie ("${name}" - ${rarity}) is bereikt.` });
            }

            // Verhoog de teller van de bestaande definitie
            existingCardDefinition.currentSupply++;
            await existingCardDefinition.save();

            // Creëer een nieuwe INSTANTIE van deze kaart (deze krijgt een eigen _id)
            cardToSave = new Card({
                name,
                type,
                attack: parseInt(attack),
                defense: parseInt(defense),
                characterImageUrl,
                backgroundImageUrl,
                rarity,
                // maxSupply en currentSupply worden beheerd door de 'definitie'
                maxSupply: existingCardDefinition.maxSupply, // Neem de maxSupply over van de definitie
                currentSupply: existingCardDefinition.currentSupply, // Neem de geüpdatete currentSupply over
                ownerId: null // Deze kaartinstantie is nog niet van iemand
            });

        } else {
            // Kaartdefinitie bestaat nog niet, maak een nieuwe definitie én de eerste instantie aan
            cardToSave = new Card({
                name,
                type,
                attack: parseInt(attack),
                defense: parseInt(defense),
                characterImageUrl,
                backgroundImageUrl,
                rarity,
                maxSupply: finalMaxSupply, // Gebruik de opgegeven maxSupply
                currentSupply: 1, // Dit is de eerste instantie
                ownerId: null // Deze kaartinstantie is nog niet van iemand
            });
        }

        await cardToSave.save(); // Sla de nieuwe kaartinstantie op
        res.status(201).json({ message: 'Kaart succesvol toegevoegd.', card: cardToSave });

    } catch (err) {
        console.error('Fout bij toevoegen kaart via admin:', err);
        res.status(500).json({ message: 'Interne serverfout bij toevoegen kaart.' });
    }
});


// AUTHENTICATIE ROUTES
app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: 'https://maelmon-trading-cards.onrender.com/' }),
    function(req, res) {
        res.redirect('https://maelmon-trading-cards.onrender.com/dashboard');
    }
);

app.get('/api/user', (req, res) => {
    if (req.user) {
        res.json({
            isLoggedIn: true,
            username: req.user.username,
            twitchId: req.user.twitchId,
            isAdmin: req.user.isAdmin
        });
    } else {
        res.json({ isLoggedIn: false });
    }
});

app.get('/auth/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('https://maelmon-trading-cards.onrender.com/');
    });
});


// 9. Twitch Bot Client
const client = new tmi.Client({
    options: { debug: true },
    connection: {
        secure: true,
        reconnect: true
    },
    identity: {
        username: process.env.TWITCH_USERNAME,
        password: process.env.TWITCH_OAUTH_TOKEN
    },
    channels: [process.env.TWITCH_CHANNEL]
});

client.connect().then(() => {
    console.log(`Twitch bot connected: ${process.env.TWITCH_USERNAME} on ${process.env.TWITCH_CHANNEL}`);
}).catch(err => {
    console.error('Fout bij verbinden met Twitch:', err);
});

client.on('message', async (channel, tags, message, self) => {
    if (self) return;

    const username = tags['display-name'];
    const twitchId = tags['user-id'];

    // !addcard commando is verwijderd zoals gevraagd

    if (message.toLowerCase() === '!hello') {
        client.say(channel, `Hello, @${username}!`);
    } else if (message.toLowerCase() === '!mycards') {
        try {
            const user = await User.findOne({ twitchId: twitchId });
            if (!user) {
                client.say(channel, `@${username}, om je kaarten te zien, moet je eerst je Twitch-account koppelen op onze website: https://maelmon-trading-cards.onrender.com/login`);
                return;
            }
            const userCards = await Card.find({ ownerId: user.twitchId });
            if (userCards.length > 0) {
                const cardNames = userCards.map(card => card.name).join(', ');
                client.say(channel, `@${username}, jouw kaarten: ${cardNames}`);
            } else {
                client.say(channel, `@${username}, je hebt nog geen kaarten. Voeg er een toe via het adminpaneel.`);
            }
        } catch (error) {
            console.error('Fout bij ophalen eigen kaarten:', error);
            client.say(channel, `@${username}, er ging iets mis bij het ophalen van je kaarten.`);
        }
    }
});


// 10. Server starten
app.listen(PORT, () => {
    console.log(`MaelMon Backend server running on http://localhost:${PORT}`);
});