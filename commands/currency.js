// commands/currency.js
// Dit bestand definieert het '!currency' commando voor je Twitch bot

module.exports = {
    name: '!currency', // De trigger voor dit commando in de chat
    description: 'Toont je huidige currency balans.', // Korte beschrijving
    async execute(client, channel, tags, message, user, args) {
        if (!user) {
            console.error(Commando !currency uitgevoerd door onbekende gebruiker: );
            await client.say(channel, @, kon je currency niet ophalen. Probeer later opnieuw.);
            return;
        }

        try {
            await client.say(channel, @, je hebt  currency.);
        } catch (chatError) {
            console.error(Fout bij sturen currency bericht aan :, chatError.message);
        }
    },
};
