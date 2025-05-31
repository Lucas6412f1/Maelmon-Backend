// models/User.js

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    twitchId: { type: String, required: true, unique: true }, // Uniek en verplicht Twitch ID
    username: { type: String, required: true }, // Twitch username (login)
    displayName: { type: String, required: true }, // Twitch display name
    profileImageUrl: { type: String }, // URL naar Twitch profielfoto
    email: { type: String }, // Gebruikers e-mail (vereist 'user:read:email' scope bij Twitch OAuth)
    currency: { type: Number, default: 0 }, // Valuta van de gebruiker
    isAdmin: { type: Boolean, default: false }, // Is de gebruiker een admin?
    accessToken: { type: String }, // Twitch Access Token (voor Twitch API calls)
    refreshToken: { type: String }, // Twitch Refresh Token (voor het vernieuwen van de Access Token)
    createdAt: { type: Date, default: Date.now } // Datum van aanmaken gebruiker
});

module.exports = mongoose.model('User', userSchema);