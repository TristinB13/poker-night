# Poker Night

Private no-limit Texas Hold'em for you and your friends. Play chips only. Everyone joins from a browser link on a phone or computer, with nothing to install.

## Why the odds match a real table

- Every hand uses a fresh 52-card deck, shuffled with a Fisher–Yates shuffle driven by the operating system's cryptographic random number generator (`crypto.randomInt`). Every one of the 52! deck orders is equally likely, which is exactly what a perfect physical shuffle gives you.
- Cards come off the top of that deck in real dealing order: one card at a time starting left of the button, and a burn card before the flop, turn, and river.
- The deck lives only on the server. Each player's browser receives only their own two cards, so nobody can peek at anyone else's hand or the next card.
- Standard rules: rotating button, heads-up blinds, minimum raises, short all-ins that don't reopen betting, side pots, split pots, and uncalled bets returned.

The tests in `test/run.js` check this. They play 200,000 random 7-card hands and compare how often each hand type appears with the known probabilities. They also run a 104,000-shuffle fairness test and about 7,000 simulated hands confirming no chips are ever created or lost.

## Run it on your computer (to try it)

1. Install Node.js 18 or newer from https://nodejs.org.
2. In this folder, run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000. To test with several players, open a few browser windows (use a private window for each extra player).

Friends on other networks can't reach your computer this way, so put it online to play for real.

## Put it online for free (Render)

1. Create a free GitHub account and a new repository. Upload everything in this folder **except** `node_modules`.
2. Create a free account at https://render.com and sign in with GitHub.
3. Click **New → Web Service** and pick your repository.
4. Use these settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
5. Click **Create Web Service**. After a couple of minutes you get a link like `https://poker-night-xxxx.onrender.com`.

Notes on the free plan:
- The server goes to sleep after about 15 minutes with no visitors, and the first visit afterward takes 30–60 seconds to wake it. Open the link a minute before game time.
- Tables are kept in memory, so if the server restarts or sleeps, any open tables are cleared. Start a new table each game night.

## How to play

1. The host enters a name, chooses starting chips, blinds, and seconds per turn, then clicks **Create table**.
2. Tap the table code at the top to copy the invite link, and send it to your friends.
3. When everyone has joined, the host presses **Start game**.
4. On your turn, choose Fold, Check/Call, or Raise. Use the slider or the Min, ½ Pot, ¾ Pot, Pot, and All-in buttons to size your bet.

More:
- **☰ menu** shows standings (each player's net win or loss), the invite link, and Leave table. The host also gets Pause and Set blinds here; new blinds start on the next hand.
- **☷** opens the hand log.
- Players who run out of chips can **Rebuy** for the starting amount. Standings count every rebuy.
- If someone runs out of time, they check if they can, otherwise they fold. Players who drop off get a short clock so the game keeps moving. Refreshing the page or reopening the link puts you back in your seat.
- Up to 9 players per table.

## Files

- `server.js`: web server and real-time connection (Express + Socket.IO)
- `src/cards.js`: deck and cryptographic shuffle
- `src/evaluator.js`: finds the best 5-card hand
- `src/table.js`: game rules (blinds, betting, side pots, showdown)
- `public/`: the web page players see
- `test/run.js`: tests (`npm test`)
