// server.js

// 1. Benodigde pakketten importeren
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const tmi = require('tmi.js');

const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('@d-fischer/passport-twitch').Strategy;

require('dotenv').config();

// 2. Express app initialiseren
const app = express();
const PORT = process.env.PORT || 10000;

// Constanten
const DAILY_PACK_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 uur in milliseconden
const STARTING_CURRENCY = 100; // Beginvaluta voor nieuwe gebruikers

// 3. Connectie maken met MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Verbonden met MongoDB Atlas!'))
    .catch(err => console.error('Fout bij verbinden met MongoDB:', err));

// 4. Mongoose Modellen definiëren
const CardSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, required: true },
    attack: { type: Number, required: true },
    defense: { type: Number, required: true },
    characterImageUrl: { type: String, required: true },
    backgroundImageUrl: { type: String, required: true },
    rarity: {
        type: String,
        enum: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Unique'],
        default: 'Common'
    },
    maxSupply: { type: Number, default: -1 },
    currentSupply: { type: Number, default: 0 },
    ownerId: { type: String, default: null } // Twitch user ID van de eigenaar
});
const Card = mongoose.model('Card', CardSchema);

const UserSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    email: { type: String, required: false },
    profileImageUrl: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    isAdmin: { type: Boolean, default: false },
    currency: { type: Number, default: STARTING_CURRENCY }, // NIEUW: Valuta
    lastPackClaimed: { type: Date, default: null } // NIEUW: Laatste claim tijdstip
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
                    isAdmin: isNewAdmin,
                    currency: STARTING_CURRENCY // NIEUW: Geef startvaluta
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
    res.status(403).json({ message: 'access denied. Admins only here sucker. Get outta here.' });
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
                return res.status(400).json({ message: 'Max supply can not be negative (except -1 for unlimited).' });
            }
        }

        let existingCardDefinition = await Card.findOne({ name, type, rarity, ownerId: null });

        let cardToSave;

        if (existingCardDefinition) {
            if (existingCardDefinition.maxSupply !== -1 && existingCardDefinition.currentSupply >= existingCardDefinition.maxSupply) {
                return res.status(400).json({ message: `Maximum supply of this card definition ("${name}" - ${rarity}) has been reached.` });
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
        res.status(201).json({ message: 'Card successfully added to database.', card: cardToSave });

    } catch (err) {
        console.error('Fout bij toevoegen kaart via admin:', err);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// NIEUW: API om dagelijks pakketje te claimen
app.post('/api/user/claim-daily-pack', isAuthenticated, async (req, res) => {
    try {
        const user = req.user;
        const now = new Date();

        if (user.lastPackClaimed && (now.getTime() - user.lastPackClaimed.getTime()) < DAILY_PACK_COOLDOWN_MS) {
            const timeLeft = DAILY_PACK_COOLDOWN_MS - (now.getTime() - user.lastPackClaimed.getTime());
            const hours = Math.floor(timeLeft / (1000 * 60 * 60));
            const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
            return res.status(400).json({ message: `You have already claimed your daily pack. Try again in ${hours} hours and ${minutes} minutes.` });
        }

        // Haal alle beschikbare kaartdefinities op (kaarten zonder eigenaarId, of templates)
        const availableCardDefinitions = await Card.find({ ownerId: null });
        if (availableCardDefinitions.length === 0) {
            return res.status(404).json({ message: 'no cards available for claim.' });
        }

        // Filter kaarten die hun maxSupply bereikt hebben
        const winnableCards = availableCardDefinitions.filter(card =>
            card.maxSupply === -1 || card.currentSupply < card.maxSupply
        );

        if (winnableCards.length === 0) {
            return res.status(400).json({ message: 'All available cards have been claimed.' });
        }

        // Selecteer een willekeurige kaart uit de winbare kaarten
        const randomIndex = Math.floor(Math.random() * winnableCards.length);
        const wonCardDefinition = winnableCards[randomIndex];

        // Maak een kopie van de kaart en wijs deze toe aan de gebruiker
        const newCardInstance = new Card({
            name: wonCardDefinition.name,
            type: wonCardDefinition.type,
            attack: wonCardDefinition.attack,
            defense: wonCardDefinition.defense,
            characterImageUrl: wonCardDefinition.characterImageUrl,
            backgroundImageUrl: wonCardDefinition.backgroundImageUrl,
            rarity: wonCardDefinition.rarity,
            maxSupply: wonCardDefinition.maxSupply, // De maxSupply blijft hetzelfde als de definitie
            ownerId: user.twitchId // Wijs de kaart toe aan de gebruiker
        });

        // Verhoog de currentSupply van de OORSPRONKELIJKE kaartdefinitie
        wonCardDefinition.currentSupply++;

        // Opslaan van de nieuwe kaartinstatie en de geüpdatete definitie
        await newCardInstance.save();
        await wonCardDefinition.save();

        // Update de gebruiker met de laatste claim tijd
        user.lastPackClaimed = now;
        await user.save();

        res.status(200).json({ message: 'congrats, you won a new card!', card: newCardInstance });

    } catch (err) {
        console.error('Fout bij claimen dagelijks pakket:', err);
        res.status(500).json({ message: 'Interne serverfout bij claimen dagelijks pakket.' });
    }
});

// AUTHENTICATIE ROUTES
app.get('/auth/twitch', passport.authenticate('twitch'));

app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: 'https://maelmon-trading-cards.onrender.com/login.html' }), // AANGEPAST: Failure redirect naar login.html
    function(req, res) {
        // Na succesvolle login, redirect naar de HOOFD app pagina (NIEUWE index.html)
        res.redirect('https://maelmon-trading-cards.onrender.com/'); // AANGEPAST: Redirect naar de nieuwe index.html
    }
);

app.get('/api/user', isAuthenticated, async (req, res) => { // Nu alleen toegankelijk voor ingelogde gebruikers
    try {
        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ isLoggedIn: false, message: 'Gebruiker niet gevonden.' });
        }
        res.json({
            isLoggedIn: true,
            username: user.username,
            twitchId: user.twitchId,
            isAdmin: user.isAdmin,
            currency: user.currency, // NIEUW: Stuur valuta mee
            lastPackClaimed: user.lastPackClaimed // NIEUW: Stuur claim tijd mee
        });
    } catch (err) {
        console.error('Fout bij ophalen gebruiker via API:', err);
        res.status(500).json({ isLoggedIn: false, message: 'Interne serverfout bij ophalen gebruiker.' });
    }
});


app.get('/auth/logout', (req, res) => {
    req.logout((err) => {
        if (err) { return next(err); }
        res.redirect('https://maelmon-trading-cards.onrender.com/login.html'); // AANGEPAST: Redirect naar login.html
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
                client.say(channel, `@${username}, to see your cards, you must first log in https://maelmon-backend.onrender.com/auth/twitch`);
                return;
            }
            const userCards = await Card.find({ ownerId: user.twitchId });
            if (userCards.length > 0) {
                const cardNames = userCards.map(card => card.name).join(', ');
                client.say(channel, `@${username}, your cards are: ${cardNames}`);
            } else {
                client.say(channel, `@${username}, you have no cards yet.`);
            }
        } catch (error) {
            console.error('Fout bij ophalen eigen kaarten:', error);
            client.say(channel, `@${username}, something went wrong while fetching your cards.`);
        }
    } else if (message.toLowerCase() === '!balance') {
        try {
            const user = await User.findOne({ twitchId: twitchId });
            if (!user) {
                client.say(channel, `@${username}, to see your balance, you must first log in: https://maelmon-backend.onrender.com/auth/twitch`);
                return;
            }
            client.say(channel, `@${username}, je hebt ${user.currency} valuta.`);
        } catch (error) {
            console.error('Fout bij ophalen valuta:', error);
            client.say(channel, `@${username}, something went wrong while fetching your balance.`);
        }
    } else if (message.toLowerCase() === '!claim') {
        try {
            const user = await User.findOne({ twitchId: twitchId });
            if (!user) {
                client.say(channel, `@${username}, to claim a daily pack, you must first log in: https://maelmon-backend.onrender.com/auth/twitch`);
                return;
            }

            const now = new Date();
            if (user.lastPackClaimed && (now.getTime() - user.lastPackClaimed.getTime()) < DAILY_PACK_COOLDOWN_MS) {
                const timeLeft = DAILY_PACK_COOLDOWN_MS - (now.getTime() - user.lastPackClaimed.getTime());
                const hours = Math.floor(timeLeft / (1000 * 60 * 60));
                const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                client.say(channel, `@${username}, you have already claimed your daily pack. Try again in ${hours} hours and ${minutes} minutes.`);
                return;
            }

            const availableCardDefinitions = await Card.find({ ownerId: null });
            const winnableCards = availableCardDefinitions.filter(card =>
                card.maxSupply === -1 || card.currentSupply < card.maxSupply
            );

            if (winnableCards.length === 0) {
                client.say(channel, `@${username}, currently there are no cards available to win.`);
                return;
            }

            const randomIndex = Math.floor(Math.random() * winnableCards.length);
            const wonCardDefinition = winnableCards[randomIndex];

            const newCardInstance = new Card({
                name: wonCardDefinition.name,
                type: wonCardDefinition.type,
                attack: wonCardDefinition.attack,
                defense: wonCardDefinition.defense,
                characterImageUrl: wonCardDefinition.characterImageUrl,
                backgroundImageUrl: wonCardDefinition.backgroundImageUrl,
                rarity: wonCardDefinition.rarity,
                maxSupply: wonCardDefinition.maxSupply,
                ownerId: user.twitchId
            });

            wonCardDefinition.currentSupply++;

            await newCardInstance.save();
            await wonCardDefinition.save();

            user.lastPackClaimed = now;
            await user.save();

            client.say(channel, `@${username}, Congrats! You have won a "${newCardInstance.name}" card!`);

        } catch (error) {
            console.error('Fout bij !claim commando:', error);
            client.say(channel, `@${username}, something went wrong.`);
        }
    } else if (message.toLowerCase() === '!commands') { // NIEUW: !commands commando
        const commands = [
            '!hello (Say hello to the bot)',
            '!mycards (See the cards you own - requires login)',
            '!mybalance (check how much money you have - requires login)',
            '!claim (claim your daily pack - requires login)',
            '!commands (see all current commands)'
        ];
        client.say(channel, `@${username}, here are the current commands: ${commands.join(' | ')}`);
    }
});


// 10. Server starten
app.listen(PORT, () => {
    console.log(`MaelMon Backend server running on http://localhost:${PORT}`);
});