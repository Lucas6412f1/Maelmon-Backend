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
    origin: ['https://maelmon-trading-cards.onrender.com', 'http://localhost:3000'], // Belangrijk: hier moet de URL van je frontend staan!
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
                const isNewAdmin = (profile.display_name === 'Lucas6412TM' || profile.display_name === 'maelsethe420');

                new User({
                    twitchId: profile.id,
                    username: profile.display_name,
                    email: profile.email,
                    profileImageUrl: profile.profile_image_url,
                    isAdmin: isNewAdmin
                }).save()
                  .then(newUser => {
                      console.log(`Nieuwe gebruiker ${newUser.username} opgeslagen. Admin status: ${newUser.isAdmin}`);
                      done(null, newUser);
                  })
                  .catch(err => done(err));
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
    if (req.isAuthenticated()) {
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

// ADMIN ROUTE: Kaarten toevoegen
app.post('/api/admin/cards', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const {
            name,
            type,
            attack,
            defense,
            characterImageUrl,
            backgroundImageUrl,
            rarity,
            maxSupply
        } = req.body;

        if (!name || !type || !attack || !defense || !characterImageUrl || !backgroundImageUrl || !rarity) {
            return res.status(400).json({ message: 'Alle verplichte kaartvelden moeten worden ingevuld.' });
        }
        if (isNaN(attack) || isNaN(defense)) {
            return res.status(400).json({ message: 'Attack en Defense moeten nummers zijn.' });
        }
        if (maxSupply !== undefined && maxSupply !== null && isNaN(parseInt(maxSupply))) {
             return res.status(400).json({ message: 'Max Supply moet een nummer zijn (-1 voor onbeperkt).' });
        }

        let finalMaxSupply = -1;
        if (maxSupply !== undefined && maxSupply !== null) {
            finalMaxSupply = parseInt(maxSupply);
            if (finalMaxSupply < -1) {
                return res.status(400).json({ message: 'Max Supply kan niet negatief zijn (behalve -1 voor onbeperkt).' });
            }
        }

        let existingCardDefinition = await Card.findOne({ name, type, rarity, ownerId: null });

        let cardToSave;

        if (existingCardDefinition) {
            if (existingCardDefinition.maxSupply !== -1 && existingCardDefinition.currentSupply >= existingCardDefinition.maxSupply) {
                return res.status(400).json({ message: `Maximum aantal van deze kaartdefinitie ("${name}" - ${rarity}) is bereikt.` });
            }

            existingCardDefinition.currentSupply++;
            await existingCardDefinition.save();

            cardToSave = new Card({
                name,
                type,
                attack: parseInt(attack),
                defense: parseInt(defense),
                characterImageUrl,
                backgroundImageUrl,
                rarity,
                maxSupply: existingCardDefinition.maxSupply,
                currentSupply: existingCardDefinition.currentSupply,
                ownerId: null
            });

        } else {
            cardToSave = new Card({
                name,
                type,
                attack: parseInt(attack),
                defense: parseInt(defense),
                characterImageUrl,
                backgroundImageUrl,
                rarity,
                maxSupply: finalMaxSupply,
                currentSupply: 1,
                ownerId: null
            });
        }

        await cardToSave.save();
        res.status(201).json({ message: 'Kaart succesvol toegevoegd.', card: cardToSave });

    } catch (err) {
        console.error('Fout bij toevoegen kaart via admin:', err);
        res.status(500).json({ message: 'Interne serverfout bij toevoegen kaart.' });
    }
});


// AUTHENTICATIE ROUTES
app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: 'https://maelmon-trading-cards.onrender.com/' }), // Frontend homepage
    function(req, res) {
        // Na succesvolle login, redirect naar de /dashboard.html path van de frontend
        res.redirect('https://maelmon-trading-cards.onrender.com/dashboard.html'); // AANGEPAST NAAR .html
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
        res.redirect('https://maelmon-trading-cards.onrender.com/'); // Frontend homepage
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

    if (message.toLowerCase() === '!hello') {
        client.say(channel, `Hello, @${username}!`);
    } else if (message.toLowerCase() === '!mycards') {
        try {
            const user = await User.findOne({ twitchId: twitchId });
            if (!user) {
                // Link direct naar de backend login endpoint zoals gevraagd
                client.say(channel, `@${username}, om je kaarten te zien, moet je eerst inloggen: https://maelmon-backend.onrender.com/auth/twitch`);
                return;
            }
            const userCards = await Card.find({ ownerId: user.twitchId });
            if (userCards.length > 0) {
                const cardNames = userCards.map(card => card.name).join(', ');
                client.say(channel, `@${username}, jouw kaarten: ${cardNames}`);
            } else {
                client.say(channel, `@${username}, je hebt nog geen kaarten.`); // Adminpaneel wordt later gemaakt
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