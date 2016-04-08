var config = require('./config');
const IRC = require('irc');
const fs = require('fs');
const _ = require('lodash');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
natural.PorterStemmer.attach();
const sqlite3 = require('sqlite3').verbose();

var allWords = [];
var protectedPlayers = {};
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
  protectedPlayers = {}
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
  if(forceWord && typeof forceWord !== 'undefined') {
    currentWord = forceWord
  } else {
    index = Math.floor(Math.random() * allWords.length)
    currentWord = allWords[index]
  }
  console.log("setting word to " + currentWord)

  if(notify) {
    announce(config.channels)
  }
  resetRound()
}

function announce(channels) {
  if(hints.length == 0) {
    for(var i = 0; i < config.hintChars; i++) {
      hints.push(Math.floor(Math.random() * currentWord.length))
    }
  }
  var masked = ""
  for(var i = 0; i < currentWord.length; i++) {
    var isHint = false
    for(var j in hints) {
      if(hints[j] == i) {
        masked += currentWord[hints[j]];
        isHint = true;
        break;
      }
    }
    if(!isHint) {
      masked += "-"
    }
  }
  for(var channelIndex in channels) {
    var channel = channels[channelIndex]
    bot.action(channel, "has selected a new secret word: " + masked + " (" + currentWord.length + " letters)! The previous word was \"" + previousWord + "\"")
  }
}

function matchesWord(text) {
  if(!text) return false;
  var tokens = text.tokenizeAndStem()
  var stemmedTarget = currentWord.stem()
  return _.includes(tokens, stemmedTarget)
}

var commands = {channel: {}, pm: {}}
function registerCommand(command, contexts, admin, callback) {
  for(var i in contexts) {
    commands[contexts[i]][command] = {auth: admin, callback: callback}
  }
}

function runCommand(cmdObj, cmd, args, user, channel) {
  if(!cmdObj) return;
  if (config.admins[user] || !cmdObj.auth) {
    cmdObj.callback(user, channel, cmd, args)
  }
}

function ensureUser(nick, cb) {
  db.get("SELECT id FROM players WHERE nick = ?", [nick], function(err, row) {
    if(!row) {
      db.run("INSERT INTO players (nick, score) VALUES (?, 0)", [nick], function() {
        cb()
      })
    } else {
      cb()
    }
  })
}

registerCommand("!guess", ["pm", "channel"], false, function(user, channel, cmd, args) {
  if(!roundRewards[user] && roundRewards[user] !== 0) {
    roundRewards[user] = config.maxRoundReward
  }

  if(protectedPlayers[user]) {
    bot.say(user, "You already know the word for this round!")
    return
  }

  ensureUser(user, function() {
    var match = matchesWord(args[0])
    if(match) {
      protectedPlayers[user] = true

      var award = roundRewards[user]
      if(hasTriggered) {
        award = Math.floor(award / 2)
      }
      if(award > 0) {
        db.run("UPDATE players SET score = score + ? WHERE nick = ?", [award, user], function(err) {
          getScore(user, function(score) {
            bot.say(user, "You have chosen...wisely! Your score is " + score + " (+" + award + ")")
          })
        })
      } else {
        bot.say(user, "You have chosen wisely...but you receive no reward.")
      }
    } else {
      roundRewards[user] -= 1
      if(roundRewards[user] < 0) {
        roundRewards[user] = 0
      }
      bot.say(user, "You have chosen...poorly. Your potential reward for this round is now " + roundRewards[user])
      protectedPlayers[user] = false
    }
  })
})

registerCommand("!newword", ["pm", "channel"], true, function(user, channel, cmd, args) {
  newTargetWord(args[0] != "silent")
  bot.say(user, "Okay, new word is " + currentWord)
})

registerCommand("!word", ["pm"], true, function(user, channel, cmd, args) {
  bot.say(user, "The word is " + currentWord + ", the stem is " + currentWord.stem())
})

registerCommand("!setword", ["pm"], true, function(user, channel, cmd, args) {
  newTargetWord(true, args[0])
  bot.say(user, "OK, the word is now " + currentWord + ", the stem is " + currentWord.stem())
})

registerCommand("!score", ["pm", "channel"], false, function(user, channel, cmd, args) {
  getScore(user, function(score) {
    var msg = "Your score is " + score
    if(channel) {
      bot.say(channel, user + ": " + msg)
    } else {
      bot.say(user, msg)
    }
  })
})

registerCommand("!buy", ["pm", "channel"], false, function(user, channel, cmd, args) {
  getScore(user, function(score) {
    if(score >= config.buyCost) {
      spend(user, config.buyCost, function(score) {
        protectedPlayers[user] = true
        bot.say(user, "The word is " + currentWord + ", the stem is " + currentWord.stem())
      })
    } else {
      bot.say(user, "You have an insufficient score to buy the word. Your balance is " + score + ", buying the word costs " + config.buyCost)
    }
  })
})

registerCommand("!award", ["pm", "channel"], true, function(user, channel, cmd, args) {
  ensureUser(user, function() {
    var award = parseInt(args[1], 10)
    db.run("UPDATE players SET score = score + ? WHERE nick = ?", [award, args[0]], function() {
      bot.say(user, args[0] + " has been awarded " + award)
      bot.say(args[0], "You have been awarded " + award + " points.")
    })
  })
})

registerCommand("!kick", ["pm"], false, function(user, channel, cmd, args) {
  getScore(user, function(score) {
    if(score >= config.kickCost) {
      spend(user, config.kickCost, function(score) {
        for(var i in config.channels) {
          maybeKick(args[0], config.channels[i])
        }
      })
    } else {
      bot.say(user, "You have an insufficient score to kick. Your balance is " + score + ", kicking costs " + config.kickCost)
    }
  })
})

registerCommand("!leaders", ["pm", "channel"], true, function(user, channel, cmd, args) {
  db.all("SELECT nick, score FROM players WHERE score > 0 ORDER BY score DESC LIMIT 10", function(err, rows) {
    var scores = _.map(rows, function(row) { return "" + row.nick + ": " + row.score })
    var target = channel ? channel : user
    bot.say(target, "Current leaderboard: " + scores.join(", "))
  })
})

var help = function(user, channel, cmd, args) {
  bot.say(user,
    "TriggerBot kicks you if you say the secret word! Words rotate every hour." + "\n" +
    "!guess <word> - guess the word for the round. Correct guesses award you points and earn you immunity from kicks." + "\n" +
    "!score - Get your current score." + "\n" +
    "!leaders - Get the leaderboard standings." + "\n" +
    "!buy - Spend " + config.buyCost + " points to learn the current word." + "\n" +
    "!kick <user> - Spend " + config.kickCost + " points to make TriggerBot trigger on <user>." + "\n" +
    "!word - Get the current word (admin only)" + "\n" +
    "!setword <word> - Set the current word (admin only)" + "\n" +
    "!newword [silent] - Select a new random word. If the silent flag is passed, do so without alerting (admin only)" + "\n" +
    "!announce - Announce the current hint (admin only)" + "\n" +
    "!award <user> <amount> - Award points to a given user (admin only)"
  )
}

registerCommand("!help", ["pm", "channel"], false, help)
registerCommand("!halp", ["pm", "channel"], false, help)

function spend(nick, amount, cb) {
  db.run("UPDATE players SET score = score - ? WHERE nick = ?", [amount, nick], function() {
    getScore(nick, function(score) {
      cb(score)
    })
  })
}

function getScore(nick, cb) {
  db.get("SELECT score FROM players WHERE nick = ?", [nick], function(err, row) {
    cb(row ? row.score : 0)
  })
}

var announceCmd = function(user, channel, cmd, args) {
  announce(channel ? [channel] : config.channels)
}
registerCommand("!announce", ["pm"], true, announceCmd)
registerCommand("!announce", ["channel"], false, announceCmd)

function command(user, text, channel) {
  var args = text.split(" ")
  var cmd = args.shift()
  if(channel && channel != config.botName) {
    runCommand(commands.channel[cmd], cmd, args, user, channel)
    return commands.channel[cmd]
  } else {
    runCommand(commands.pm[cmd], cmd, args, user, channel)
    return commands.pm[cmd]
  }
}

function randomDelay(min, max) {
  return Math.random() * (max - min) + min
}

var pendingKicks = []
var kicker = false;
function maybeKick(user, channel) {
  if(protectedPlayers[user]) return;
  if(config.immune[user]) return;

  setTimeout(function() {
    bot.say(channel, "⏰ Someone said the secret word! ⏰");
    hasTriggered = true
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
          bot.say("chanserv", "op " + channel);
          setTimeout(function() {
            for(var i in pendingKicks) {
              bot.send("KICK", pendingKicks[i].channel, pendingKicks[i].user, "You said the secret word! (Feel free to rejoin)");
              totalKicks += 1
            }

            if(pendingKicks.length == 2) {
              bot.say(channel, "DOUBLE KILL")
            } else if(pendingKicks.length == 3) {
              bot.say(channel, "MULTI KILL")
            } else if(pendingKicks.length == 4) {
              bot.say(channel, "MEGA KILL")
            } else if(pendingKicks.length == 5) {
              bot.say(channel, "ULTRA KILL")
            } else if(pendingKicks.length == 6) {
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
        bot.action(channel, "has spared " + user + " from a humiliating end.");
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
    if(nick == config.botName && currentWord) {
      announce([channel])
    }
  })

  newTargetWord(false)
}