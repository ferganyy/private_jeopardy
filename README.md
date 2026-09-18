# Buzz Battle

A realtime, Jeopardy-inspired party trivia game for phones and computers. Players join the same online room, talk out loud, buzz from their own device, and self-judge spoken answers.

## Included

- 2 boards, each with 6 categories × 5 clues (60 clues total)
- Round 1 values: $200–$1,000
- Round 2 values: $400–$2,000
- 1 randomized Daily Double in Round 1 and 2 randomized Daily Doubles in Round 2
- Daily Double wagers follow the requested rule:
  - positive score → wager from $0 up to the current score
  - negative score → wager from $0 up to the amount needed to get back to $0
  - score of $0 → maximum wager is $0
- First-buzz-wins realtime buzzing
- 30-second answer timer after a buzz
- The clue disappears for everyone while somebody is answering
- The answering player can privately reveal the official answer, then self-mark Right/Wrong
- On a wrong answer or timeout, the clue reappears for everyone else; that player cannot buzz again on that clue
- Individual Skip buttons; an unanswered clue closes only when every connected player has skipped or missed
- Optional browser TTS that chooses the best available English system voice
- Optional sound effects
- Keyboard Spacebar buzzer on desktop + giant touch buzzer on mobile
- Responsive phone/desktop layout
- Daily Double animation, animated timer, board effects, confetti, score feedback, and finale effects
- Reconnect support if a player refreshes the page
- No database and no external packages: just Node.js

## Quick Money finale

After Board 2, the top two players advance to a 5-question survey-style Quick Money round. Both finalists answer each prompt aloud before the answer board is revealed. Each finalist then taps the survey response matching what they said (or 0 if it is not on the board).

To make the two-board score matter in the finale, the leader starts with a small head start equal to **1 Quick Money point per $100 of lead, capped at 50 points**. This is an intentional house rule and is easy to change in `server.js`.

The included survey answers and point values are demo content, not results from a real survey.

## Run locally

You need Node.js 18 or newer.

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

For testing on phones on the same Wi-Fi, open the computer's LAN IP plus port 3000, for example `http://192.168.1.25:3000`.

## Put it online

### Render (easy)

1. Put this folder in a GitHub repository.
2. In Render, create a new **Blueprint** or **Web Service** from the repository.
3. The included `render.yaml` already defines the service.
4. After deployment, share the Render URL with your friend.
5. One person creates a room and sends the invite link or 4-character room code.

The project also works on other Node hosts such as Railway, Fly.io, a VPS, or a home server exposed through a tunnel.

## Customize the game

Edit `game-data.js`.

Each board category contains five clues with:

```js
{ value: 200, q: "Question text", a: "Official answer" }
```

The Quick Money section contains prompts and answer choices:

```js
{
  q: "Survey prompt",
  answers: [
    { text: "Top answer", points: 35 },
    { text: "Second answer", points: 25 }
  ]
}
```

Restart the server after editing `game-data.js`.

## Assumptions I used

- Supports 2–6 players, even though the original request mentioned playing with a friend.
- Standard clue control: whoever answers correctly gets selection control; the host can also click a clue as an override.
- The lowest-scoring player gets first selection in Board 2.
- A timeout counts as a wrong answer and deducts the clue value.
- A player who skips or misses cannot later buzz on that same clue.
- Daily Doubles are solo questions for the player with selection control and do not open to other buzzers after a miss.
- Ties for the second Quick Money slot currently fall back to original join order.
- Browser TTS is used so there is no API key or usage bill; voice quality depends on the phone/computer/browser.

## Files

- `server.js` — realtime room/game logic and built-in web server
- `game-data.js` — both boards and Quick Money content
- `public/index.html` — app shell
- `public/styles.css` — responsive design and animations
- `public/app.js` — browser UI, TTS, buzzer, effects, and networking
- `render.yaml` — one-step Render deployment configuration
