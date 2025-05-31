// server.js

// 1. Benodigde pakketten importeren
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Voor cross-origin verzoeken (frontend naar backend)
const tmi = require('tmi.js'); // Voor de Twitch bot

// NIEUWE IMPORTS VOOR AUTHENTICATIE
const session = require('express-session');
const passport = require('passport');
const TwitchStrategy = require('passport-twitch').Strategy;

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
    // NIEUW: Voeg een veld toe om de kaart aan een gebruiker te koppelen
    // Dit wordt ingevuld nadat de user model is gemaakt en de bot logica is aangepast
    ownerId: { type: String, default: null } // Twitch user ID van de eigenaar
});
const Card = mongoose.model('Card', CardSchema);

// NIEUW: User Model Placeholder (dit is de volgende stap!)
// Je zult dit vervangen door een echt Mongoose schema voor gebruikers.
// Voor nu dient het alleen om de Passport-functies te laten werken.
const UserSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    email: { type: String, required: false }, // afhankelijk van de scope die je vraagt
    profileImageUrl: { type: String, required: false },
    // andere user-specifieke data
});
const User = mongoose.model('User', UserSchema);


// 5. Middleware configureren
// CORS instellingen
app.use(cors({
    // Pas dit aan naar de exacte URL(s) van je frontend
    origin: ['https://maelmon-trading-cards.onrender.com', 'http://localhost:3000'],
    credentials: true // Belangrijk voor het versturen van cookies (sessies) over domeinen heen
}));
app.use(express.json()); // Voor het parsen van JSON body's

// NIEUW: Express Session middleware
// Nodig voor het opslaan van de gebruikerssessie
app.use(session({
    secret: process.env.SESSION_SECRET, // Moet een lange, willekeurige en GEHEIME string zijn!
    resave: false, // Sessie niet opnieuw opslaan als er geen wijzigingen zijn
    saveUninitialized: false, // Geen sessie opslaan voor niet-geauthenticeerde gebruikers
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true in productie (HTTPS), false lokaal
        httpOnly: true, // Voorkomt client-side JavaScript toegang tot cookie
        maxAge: 24 * 60 * 60 * 1000 // 24 uur (hoe lang de sessie geldig is)
    }
}));

// NIEUW: Initialiseer Passport
app.use(passport.initialize());
app.use(passport.session()); // Gebruik sessies voor persistente logins

// 6. Passport Twitch Strategie configureren
passport.use(new TwitchStrategy({
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    callbackURL: "https://maelmon-trading-cards.onrender.com/auth/twitch/callback", // MOET OVEREENKOMEN met de URL in je Twitch Dev Console!
    scope: "user:read:email", // Vraag permissie om de e-mail van de gebruiker te lezen (optioneel)
    // Voeg hier ook 'channel:read:subscriptions', 'channel:read:redemptions' of andere scopes toe die je bot nodig heeft
},
function(accessToken, refreshToken, profile, done) {
    // Deze functie wordt aangeroepen na succesvolle authenticatie bij Twitch
    // 'profile' bevat de gebruikersinformatie van Twitch
    // Hier moet je de gebruiker opslaan of vinden in je eigen database (MongoDB)

    User.findOne({ twitchId: profile.id })
        .then(currentUser => {
            if (currentUser) {
                // Gebruiker bestaat al, return die gebruiker
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
                      done(null, newUser);
                  })
                  .catch(err => done(err));
            }
        })
        .catch(err => done(err));
}
));

// 7. Passport: Hoe gebruikersdata in en uit de sessie wordt opgeslagen
// Dit is cruciaal voor Passport om gebruikerssessies te onderhouden.
passport.serializeUser((user, done) => {
    // Opslaan van de gebruikers-ID in de sessie
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    // Op basis van de ID in de sessie, de gebruiker ophalen uit de database
    // HIER WORDT HET BELANG VAN HET USER MODEL DUIDELIJK
    User.findById(id)
        .then(user => {
            done(null, user);
        })
        .catch(err => done(err));
});


// 8. API Routes
// Algemene route om alle kaarten op te halen (kan later worden gefilterd per gebruiker)
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
    passport.authenticate('twitch', { failureRedirect: '/' }), // Redirect naar homepage bij falen
    function(req, res) {
        // Succesvolle authenticatie, redirect naar een dashboard of profielpagina
        // Dit moet de URL van je frontend zijn waar je de ingelogde gebruiker naartoe stuurt
        res.redirect('https://maelmon-trading-cards.onrender.com/dashboard'); // Of een andere relevante pagina
    }
);

// Optionele route om de ingelogde gebruiker te testen
app.get('/api/user', (req, res) => {
    if (req.user) { // req.user is beschikbaar via Passport als de gebruiker is ingelogd
        res.json({
            isLoggedIn: true,
            username: req.user.username,
            twitchId: req.user.twitchId,
            // Stuur geen gevoelige data zoals accessToken
        });
    } else {
        res.json({ isLoggedIn: false });
    }
});

// Route om uit te loggen
app.get('/auth/logout', (req, res) => {
    req.logout((err) => { // Passport's logout functie
        if (err) { return next(err); }
        res.redirect('https://maelmon-trading-cards.onrender.com/'); // Redirect naar homepage na uitloggen
    });
});


// 9. Twitch Bot Client (deze had je waarschijnlijk al)
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
    if (self) return; // Ignore messages from the bot itself

    const username = tags['display-name'];
    const twitchId = tags['user-id']; // Deze is belangrijk voor koppeling!

    if (message.toLowerCase().startsWith('!addcard ')) {
        const args = message.slice('!addcard '.length).split(',');

        if (args.length === 5) {
            const [name, type, attack, defense, imageUrl] = args.map(arg => arg.trim());

            // Voorbeeld van het opslaan van een kaart (deze logica moet later worden aangepast
            // om te controleren of de gebruiker is gekoppeld aan een account
            // en om de ownerId in te vullen)
            try {
                // Zoek of de Twitch-gebruiker in onze database bestaat
                const user = await User.findOne({ twitchId: twitchId });

                if (!user) {
                    // Gebruiker is niet gekoppeld aan een account in onze DB
                    client.say(channel, `@${username}, om kaarten toe te voegen, moet je eerst je Twitch-account koppelen op onze website: https://maelmon-trading-cards.onrender.com/login`); // Of de URL van je login pagina
                    return; // Stop de functie hier
                }

                const newCard = new Card({
                    name,
                    type,
                    attack: parseInt(attack),
                    defense: parseInt(defense),
                    imageUrl,
                    ownerId: user.twitchId // Vul de ownerId in met de Twitch user ID
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
    } else if (message.toLowerCase() === '!mycards') { // Nieuwe test command
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