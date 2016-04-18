"use strict";
var config = require('./config');
const IRC = require('irc');
const fs = require('fs');
const _ = require('lodash');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
natural.PorterStemmer.attach();
const sqlite3 = require('sqlite3').verbose();

var allWords = [];
var protectedPlayers = new Map();
var bot;
var currentWord = "(none)";
var previousWord = "(none)";
var newWordTimer;
var totalKicks = 0;
var db = new sqlite3.Database('wordbot.db');
var allWords = [];
var roundRewards = {}
var hasTriggered = false
var hints = []

fs.readFile('wordlist3.txt', 'utf8', function (err,data) {
  if (err) {
    return console.log(err);
  }
  allWords = _.uniq(data.split("\n"))
  start();
});

function resetRound() {
  protectedPlayers.clear()
  roundRewards = {}
  totalKicks = 0
  hasTriggered = false
  hints = []
  if(newWordTimer) {
    clearTimeout(newWordTimer)
  }
  newWordTimer = setTimeout(function() {
    newTargetWord(true)
  }, config.changeInterval)
}

function newTargetWord(notify, forceWord) {
  previousWord = currentWord;
  if(forceWord && forceWord !== undefined) {
    currentWord = forceWord
  } else {
    while(true) {
      let index = Math.floor(Math.random() * allWords.length)
      currentWord = allWords[index]
      if(currentWord && currentWord.length > 0) {
        break;
      }
    }
  }
  console.log("setting word to " + currentWord)

  if(notify) {
    announce(config.channels)
  }
  resetRound()
}

function announce(channels) {
  if(hints.length === 0) {
    for(let i = 0; i < config.hintChars; i++) {
      hints.push(Math.floor(Math.random() * currentWord.length))
    }
  }
  let masked = ""
  for(let i = 0; i < currentWord.length; i++) {
    let hint = hints.find(j => j === i)
    if(hint !== undefined) {
      masked += currentWord[hint];
    } else {
      masked += "-"
    }
  }
  channels.forEach(ch => {
    bot.action(ch, `has selected a new secret word: ${masked} (${currentWord.length} letters)! The previous word was "${previousWord}"`)
  })
}

function matchesWord(text) {
  if(!text) return false;
  let tokens = text.tokenizeAndStem()
  let stemmedTarget = currentWord.stem()
  return tokens.find(t => t === stemmedTarget)
}

var commands = {channel: new Map(), pm: new Map(), raw: new Map()}
function registerCommand(command, options) {
  if(options.contexts === undefined)
    options.contexts = ["pm", "channel"]
  commands.raw.set(command, options)
  options.contexts.forEach(ctx => commands[ctx].set(command, {auth: options.admin, callback: options.run}))
}

function runCommand(cmdObj, cmd, args, user, channel) {
  if(!cmdObj) return;
  if (config.admins[user] || !cmdObj.auth) {
    cmdObj.callback(user, channel, cmd, args)
  }
}

function ensureUser(nick, cb) {
  db.get("SELECT id FROM players WHERE LOWER(nick) = LOWER(?)", [nick], function(err, row) {
    if(!row) {
      db.run("INSERT INTO players (nick, score) VALUES (?, 0)", [nick], function() {
        cb()
      })
    } else {
      cb()
    }
  })
}

registerCommand("!guess", {
  doc: { params: "<word>", msg: "guess the word for the round. Correct guesses award you points and earn you immunity from kicks." },
  run: function(user, channel, cmd, args) {
    if(!roundRewards[user] && roundRewards[user] !== 0) {
      roundRewards[user] = config.maxRoundReward
    }

    if(protectedPlayers.has(user)) {
      bot.say(user, "You already know the word for this round!")
      return
    }

    ensureUser(user, function() {
      let match = matchesWord(args[0])
      let award = roundRewards[user]
      if(award == 0) {
        bot.say(user, "You have no more guesses remaining for this round.")
      } else if(match) {
        protectedPlayers.set(user, true)
        if(hasTriggered) {
          award = Math.floor(award / 2)
        }
        db.run("UPDATE players SET score = score + ? WHERE LOWER(nick) = LOWER(?)", [award, user], function(err) {
          getScore(user, function(score) {
            let modifier = ""
            if(hasTriggered) {
              modifier = ", -50% post-trigger penalty"
            }
            bot.say(user, `You have chosen...wisely! Your score is ${score} (+${award}${modifier})`)
          })
        })
      } else {
        roundRewards[user] -= 1
        if(roundRewards[user] < 0) {
          roundRewards[user] = 0
        }
        bot.say(user, "You have chosen...poorly. Your potential reward for this round is now " + roundRewards[user])
        protectedPlayers.delete(user)
      }
    })
  }
})

registerCommand("!newword", {
  doc: { params: "[silent]", msg: "Select a new random word. If the silent flag is passed, do so without alerting" },
  admin: true,
  run: function(user, channel, cmd, args) {
    newTargetWord(args[0] != "silent")
    bot.say(user, `Okay, new word is ${currentWord}`)
  }
})

registerCommand("!word", {
  contexts: ["pm"],
  doc: "Get the current word",
  admin: true,
  run: function(user, channel, cmd, args) {
    bot.say(user, `The word is ${currentWord}, the stem is ${currentWord.stem()}`)
  }
})

registerCommand("!setword", {
  contexts: ["pm"],
  doc: {params: "<word>", msg: `Spend ${config.setCost} to set the new word`},
  run: function(user, channel, cmd, args) {
    if(!args[0]) {
      bot.say(user, "Please specify a word")
    } else if(args[0].length < 3) {
      bot.say(user, "Word length must be at least 3 characters")
    } else {
      let setNewWord = function() {
        protectedPlayers.set(user, true)
        newTargetWord(true, args[0])
        bot.say(user, `OK, the word is now ${currentWord}, the stem is ${currentWord.stem()}`)
      }
      if(config.admins[user]) {
        setNewWord()
      } else {
        getScore(user, function(score) {
          if(score >= config.buyCost) {
            spend(user, config.setCost, setNewWord)
          } else {
            bot.say(user, `You have an insufficient score to buy the word. Your balance is ${score}, buying the word costs ${config.setCost}`)
          }
        })
      }
    }
  }
})

registerCommand("!score", {
  doc: {params: "[user]", msg: "Get your score, or the score for [user]"},
  run: function(user, channel, cmd, args) {
    console.log(user, channel, cmd, args)
    let nick = args.length > 0 ? args[0] : user
    getScore(nick, function(score) {
      let msg = `${nick}'s score score is ${score}`
      if(channel) {
        bot.say(channel, `${user}: ${msg}`)
      } else {
        bot.say(user, msg)
      }
    })
  }
})

registerCommand("!buy", {
  doc: `Spend ${config.buyCost} points to learn the current word.`,
  run: function(user, channel, cmd, args) {
    getScore(user, function(score) {
      if(score >= config.buyCost) {
        spend(user, config.buyCost, function(score) {
          protectedPlayers.set(user, true)
          bot.say(user, `The word is ${currentWord}, the stem is ${currentWord.stem()}`)
        })
      } else {
        bot.say(user, `You have an insufficient score to buy the word. Your balance is ${score}, buying the word costs ${config.buyCost}`)
      }
    })
  }
})

registerCommand("!award", {
  admin: true,
  doc: {params: "<user> <amount>", msg: "Award points to a given user"},
  run: function(user, channel, cmd, args) {
    ensureUser(user, function() {
      let award = parseInt(args[1], 10)
      db.run("UPDATE players SET score = score + ? WHERE LOWER(nick) = LOWER(?)", [award, args[0]], function() {
        bot.say(user, args[0] + " has been awarded " + award)
        bot.say(args[0], "You have been awarded " + award + " points.")
      })
    })
  }
})

registerCommand("!kick", {
  contexts: ["pm"],
  doc: {params: "<user>", msg: `Spend ${config.kickCost} points to make TriggerBot trigger on <user>.`},
  run: function(user, channel, cmd, args) {
    let target = args[0]
    playerExists(target, function(exists) {
      if(exists) {
        getScore(user, function(score) {
          if(score >= config.kickCost) {
            spend(user, config.kickCost, function(score) {
              config.channels.forEach(ch => maybeKick(target, ch, true))
            })
          } else {
            bot.say(user, "You have an insufficient score to kick. Your balance is " + score + ", kicking costs " + config.kickCost)
          }
        })
      } else {
        bot.say(user, "That player has not yet participated in the game")
      }
    })
  }
})

registerCommand("!leaders", {
  doc: "Get the leaderboard standings.",
  run: function(user, channel, cmd, args) {
    db.all("SELECT nick, score FROM players WHERE score > 0 ORDER BY score DESC LIMIT 10", function(err, rows) {
      let scores = rows.map(row => "" + row.nick + ": " + row.score)
      let target = channel ? channel : user
      bot.say(target, "Current leaderboard: " + scores.join(", "))
    })
  }
})

var help = function(user, channel, cmd, args) {
  let helpMsgs = []
  for (var cmd of commands.raw.keys()) {
    let opts = commands.raw.get(cmd)
    if(opts.doc) {
      let msg = opts.doc.msg === undefined ? opts.doc : opts.doc.msg
      let params = opts.doc.params
      let admin = opts.admin ? " (admin only)" : ""
      if(params) {
        helpMsgs.push(`${cmd} ${params} - ${msg}${admin}`)
      } else {
        helpMsgs.push(`${cmd} - ${msg}${admin}`)
      }
    }
  }
  bot.say(user, helpMsgs.join("\n"))
}
let helpOps = {
  doc: "This command",
  run: help
}

registerCommand("!help", helpOps)
registerCommand("!halp", helpOps)

function spend(nick, amount, cb) {
  db.run("UPDATE players SET score = score - ? WHERE LOWER(nick) = LOWER(?)", [amount, nick], function() {
    getScore(nick, function(score) {
      cb(score)
    })
  })
}

function getScore(nick, cb) {
  db.get("SELECT score FROM players WHERE LOWER(nick) = LOWER(?)", [nick], function(err, row) {
    cb(row ? row.score : 0)
  })
}

function playerExists(nick, cb) {
  db.get("SELECT score FROM players WHERE LOWER(nick) = LOWER(?)", [nick], function(err, row) {
    cb(row ? true : false)
  })
}

var announceCmd = function(user, channel, cmd, args) {
  announce(channel ? [channel] : config.channels)
}
registerCommand("!announce", {run: announceCmd})

function command(user, text, channel) {
  var args = text.split(" ")
  var cmd = args.shift()
  if(channel && channel != config.botName && commands.channel.has(cmd)) {
    runCommand(commands.channel.get(cmd), cmd, args, user, channel)
    return true
  } else if (commands.pm.get(cmd)) {
    runCommand(commands.pm.get(cmd), cmd, args, user, undefined)
    return true
  }
}

function randomDelay(min, max) {
  return Math.random() * (max - min) + min
}

var pendingKicks = []
var kicker = false;
function maybeKick(user, channel, isManual) {
  if(protectedPlayers.has(user)) return;
  if(config.immune[user]) return;

  setTimeout(function() {
    bot.say(channel, "⏰ Someone said the secret word! ⏰");
    if(!isManual) {
      hasTriggered = true
    }
    setTimeout(function() {
      var thumbsRoll = Math.random();
      console.log(user, "thumbs up/down roll:", thumbsRoll, thumbsRoll < 0.6 ? "kill" : "spare")
      if(thumbsRoll < 0.6) {
        if(!kicker) {
          bot.action(channel, "is acquiring a target... ̿' ̿'\̵͇̿̿\з=(◕_◕)=ε/̵͇̿̿/'̿'̿ ̿");
        }

        pendingKicks.push({channel: channel, user: user})
        pendingKicks = _.uniqBy(pendingKicks, 'user')
        if(kicker) {
          clearTimeout(kicker)
        }
        kicker = setTimeout(function() {
          if(!isManual && protectedPlayers.size > 0) {
            for(let player of protectedPlayers.keys()) {
              spend(player, -1, function(){})
            }
            bot.say(channel, `Awarded ${protectedPlayers.size} points`)
          }
          bot.say("chanserv", "op " + channel);
          setTimeout(function() {
            pendingKicks.forEach(kick => {
              bot.send("KICK", kick.channel, kick.user, "You said the secret word! (Feel free to rejoin)");
              totalKicks += 1
            })

            if(pendingKicks.length === 2) {
              bot.say(channel, "DOUBLE KILL")
            } else if(pendingKicks.length === 3) {
              bot.say(channel, "MULTI KILL")
            } else if(pendingKicks.length === 4) {
              bot.say(channel, "MEGA KILL")
            } else if(pendingKicks.length === 5) {
              bot.say(channel, "ULTRA KILL")
            } else if(pendingKicks.length === 6) {
              bot.say(channel, "M-M-M-MONSTER KILL")
            } else if(pendingKicks.length > 6) {
              bot.say(channel, "HOLY SHIT!")
            }

            pendingKicks = []
            bot.say("chanserv", "deop " + channel);
            kicker = false;
            if(totalKicks >= config.changeAfterKicks) {
              newTargetWord(true)
            }
          }, 1000)
        }, randomDelay(3000, 9000));
      } else {
        bot.action(channel, `has spared ${user} from a humiliating end.`);
      }
    }, 1000);
  }, randomDelay(3000, 9000));
}

function start() {
  bot = new IRC.Client(config.server, config.botName, {
    channels: config.channels,
    debug: true
  });

  bot.addListener("message", function(from, to, text, message) {
    var msg = message.args[1]
    if(!command(from, text, to) && matchesWord(text)) {
      maybeKick(from, to);
    }
  });

  bot.addListener("error", function(message) {
    console.log(message)
  })

  bot.addListener("registered", function() {
    bot.say("NickServ", "IDENTIFY " + config.password);
  })

  bot.addListener("join", function(channel, nick, message) {
    if(nick === config.botName && currentWord) {
      announce([channel])
    }
  })

  newTargetWord(false)
  console.log("Ready to roll!")
}