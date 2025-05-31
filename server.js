// server.js

// 1. Benodigde pakketten importeren
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Voor cross-origin verzoeken (frontend naar backend)
const tmi = require('tmi.js'); // Voor de Twitch bot

// NIEUWE IMPORTS VOOR AUTHENTICATIE
const session = require('express-session');
const passport = require('passport');
// >>> BELANGRIJK: Dit is de bijgewerkte import!
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

// 4. Mongoose Modellen definiëren (Voorbeeld: Card Model)
// Zorg ervoor dat dit overeenkomt met je bestaande Card model
// of voeg het hier toe als het nog niet bestaat.
const CardSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, required: true },
    attack: { type: Number, required: true },
    defense: { type: Number, required: true },
    imageUrl: { type: String, required: true },
    ownerId: { type: String, default: null } // Twitch user ID van de eigenaar
});
const Card = mongoose.model('Card', CardSchema);

// NIEUW: User Model
// Dit is het model dat gebruikersgegevens opslaat in je MongoDB
const UserSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    email: { type: String, required: false },
    profileImageUrl: { type: String, required: false },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);


// 5. Middleware configureren
// CORS instellingen
app.use(cors({
    origin: ['https://maelmon-trading-cards.onrender.com', 'http://localhost:3000'],
    credentials: true
}));
app.use(express.json());

// NIEUW: Express Session middleware
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

// NIEUW: Initialiseer Passport
app.use(passport.initialize());
app.use(passport.session());

// 6. Passport Twitch Strategie configureren
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    // >>> BELANGRIJK: Dit is de URL van JE BACKEND SERVICE!
    // >>> Deze moet EXACT OVEREENKOMEN met de Redirect URL in je Twitch Dev Console!
    callbackURL: "https://maelmon-backend.onrender.com/auth/twitch/callback",
    scope: "user:read:email", // Scopes die je wilt aanvragen van de gebruiker
},
function(accessToken, refreshToken, profile, done) {
    // Deze functie wordt aangeroepen na succesvolle authenticatie bij Twitch
    // 'profile' bevat de gebruikersinformatie van Twitch
    // Hier moet je de gebruiker opslaan of vinden in je eigen database (MongoDB)

    User.findOne({ twitchId: profile.id })
        .then(currentUser => {
            if (currentUser) {
                // Gebruiker bestaat al, return die gebruiker
                console.log(`Gebruiker ${currentUser.username} al bekend, ingelogd.`);
                done(null, currentUser);
            } else {
                // Nieuwe gebruiker, maak een nieuw record aan
                new User({
                    twitchId: profile.id,
                    username: profile.display_name,
                    email: profile.email,
                    profileImageUrl: profile.profile_image_url
                }).save()
                  .then(newUser => {
                      console.log(`Nieuwe gebruiker ${newUser.username} opgeslagen.`);
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

// NIEUWE AUTHENTICATIE ROUTES
// Route om de OAuth-flow te starten (login met Twitch)
app.get('/auth/twitch', passport.authenticate('twitch'));

// Callback route na authenticatie bij Twitch
app.get('/auth/twitch/callback',
    passport.authenticate('twitch', { failureRedirect: 'https://maelmon-trading-cards.onrender.com/' }), // Redirect naar homepage frontend bij falen
    function(req, res) {
        // Succesvolle authenticatie, redirect naar een dashboard of profielpagina op je frontend
        res.redirect('https://maelmon-trading-cards.onrender.com/dashboard'); // Of een andere relevante pagina op je frontend
    }
);

// Optionele route om de ingelogde gebruiker te testen
app.get('/api/user', (req, res) => {
    if (req.user) {
        res.json({
            isLoggedIn: true,
            username: req.user.username,
            twitchId: req.user.twitchId,
        });
    } else {
        res.json({ isLoggedIn: false });
    }
});

// Route om uit te loggen
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

    if (message.toLowerCase().startsWith('!addcard ')) {
        const args = message.slice('!addcard '.length).split(',');

        if (args.length === 5) {
            const [name, type, attack, defense, imageUrl] = args.map(arg => arg.trim());

            try {
                const user = await User.findOne({ twitchId: twitchId });

                if (!user) {
                    client.say(channel, `@${username}, om kaarten toe te voegen, moet je eerst je Twitch-account koppelen op onze website: https://maelmon-trading-cards.onrender.com/login`);
                    return;
                }

                const newCard = new Card({
                    name,
                    type,
                    attack: parseInt(attack),
                    defense: parseInt(defense),
                    imageUrl,
                    ownerId: user.twitchId
                });

                await newCard.save();
                client.say(channel, `@${username}, kaart "${name}" succesvol toegevoegd aan je collectie!`);
            } catch (error) {
                console.error('Fout bij toevoegen kaart:', error);
                client.say(channel, `@${username}, er ging iets mis bij het toevoegen van de kaart. Controleer het formaat: !addcard Naam,Type,Attack,Defense,ImageURL`);
            }
        } else {
            client.say(channel, `@${username}, Gebruik: !addcard Naam,Type,Attack,Defense,ImageURL`);
        }
    } else if (message.toLowerCase() === '!hello') {
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
                client.say(channel, `@${username}, je hebt nog geen kaarten. Voeg er een toe met !addcard.`);
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