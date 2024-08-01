import fs from 'node:fs';
import fetch from 'node-fetch';
import formatDistance from 'date-fns/formatDistance/index.js';
import { Client, GatewayIntentBits } from 'discord.js';

const config = await JSON.parse(fs.readFileSync('./config.json'));


var currentAPI = 0;
var retries = 0;

var db = {
  down: [],
  missers: {},
  leaders: [],
  isChainHalted: true,
  chainHaltedMessageSent: false,
  chainRecoveredMessageSent: false,
  sameBlockCounter: 0,
  lastBlockTs: Date.now(),
};

db.sameBlockCounter = db.sameBlockCounter || 0;
const watcher = async () => {
  try {
    // Save old leaders to compare
    const old = db.leaders;

    // Get new leaders data
    await update_db_leaders();

    // Alert leaders that unregistered
    old.filter(o => (db.leaders.find(l => l.name === o.name) === undefined)).map(async leader => {
      await telegram(`Leader${candidate} \`${leader.name}\` unregistered`)
      await discord(`Leader${candidate} \`${leader.name}\` unregistered`)
      await ntfy(`Leader${candidate} \`${leader.name}\` unregistered`)
    });

    // Actual missers
    const missers = Object.keys(db.missers);

    // Compare new leaders from db with old
    db.leaders.map(async (leader, index) => {
      // Check if this leader is producing or just a candidate
      const candidate = index < 5 ? '' : ' candidate';

      // Find the old leader
      const oldLeader = old.find(l => l.name === leader.name);

      // Leader not found in old leaders db?
      if (oldLeader === undefined) {
        await telegram(`Leader${candidate} \`${leader.name}\` registered`);
        await discord(`Leader${candidate} \`${leader.name}\` registered`);
        await ntfy(`Leader${candidate} \`${leader.name}\` registered`);
        return;
      }

      // Is this leader an actual misser?
      if (missers.includes(leader.name)) {
        // Get misser data from db
        const misser = db.missers[leader.name];

        // Calc total and new misses
        const total = leader.missed - misser.start + 1;
        const misses = leader.missed - misser.last;

        // First, check if started producing again or got out of schedule
        if (leader.missed === oldLeader.missed) {
          // Sometimes the API is still not updated when this watcher is run causing
          // false 'back producing' messages, so ignore if on schedule and still not produced
          // blocks yet
          if (candidate || leader.produced > oldLeader.produced) {
            const action =  !candidate ? 'started producing again' : 'is out of schedule';
            await telegram(`Leader${candidate} \`${leader.name}\` ${action}, after missing *${total}* block(s), total blocks missed now is *${leader.missed}*`);
            await discord(`@here Leader${candidate} \`${leader.name}\` ${action}, after missing *${total}* block(s), total blocks missed now is *${leader.missed}*`);
            await ntfy(`Leader${candidate} \`${leader.name}\` ${action}, after missing *${total}* block(s), total blocks missed now is *${leader.missed}*`);
            // Remove misser from db
            delete db.missers[leader.name];
            savedb();
          }
          return;
        }

        // Get triggers from config
        const repeater = config.watcher.triggers[0];
        const triggers = config.watcher.triggers.slice(1);
        var message = false;

        // Total misses are less than repeater trigger?
        if (total < repeater) {
          // Message if found one that fits, through all triggers that didn't fire yet
          message = (triggers.find(t => (t >= (total - misses) && t <= misses)) !== undefined);
        } else {
          // Message if new misses greater or equal than repeater
          message = (misses >= repeater);
        }

        // Send message?
        if (message && config.remind) {
          await telegram(`Leader${candidate} \`${leader.name}\` continues missing, now with *${total}* block(s) missed`);
          await discord(`Leader${candidate} \`${leader.name}\` continues missing, now with *${total}* block(s) missed`);
          await ntfy(`Leader${candidate} \`${leader.name}\` continues missing, now with *${total}* block(s) missed`);
          // Update last message missed in db
          misser.last = leader.missed;
          savedb();
        }
      } else {
        // Calc the misses
        const misses = leader.missed - (oldLeader.missed || 0)-20;

        // Are there any misses?
        if (misses > 0) {
          // Add to missers in db
          db.missers[leader.name] = {
            produced: leader.produced,
            start: oldLeader.missed + 1,
            last: leader.missed
          };
          savedb();

          await telegram(`Leader${candidate} \`@${leader.name}\` missed *${misses+20}* block(s)`);
          await discord(`@here Leader${candidate} \`@${leader.name}\` missed *${misses+20}* block(s)`);
          await ntfy(`Leader${candidate} \`@${leader.name}\` missed *${misses+20}* block(s)`);
        }
      }
    });

  } catch (e) {
    console.error('API node', config.apis[currentAPI], 'failed to retrieve leader data, reason:', e);
    // Retry the watcher because this might happen due to communication errors with the node...
    console.log('Retrying the watcher in a bit...');
    scheduleRetry(watcher);
    return;
  }

  savedb();
}

const APIwatcher = async () => {
  // Save old leaders to compare
  const old = db.down || [];

  const nodes = await get_api_nodes_down();

  // If lost contact with all nodes, maybe it's a network issue?
  if (nodes.length === config.apiwatcher.nodes.length) {
    console.log('Lost contact with all API nodes at once, maybe network issue? Skipping...');
    return;
  }

  // Get current timestamp
  const now = Date.now();

  // Alert api nodes back up
  old.filter(api => !nodes.includes(api.node)).map(async api => {
    await telegram(`API node ${api.node} is back up, it was down for ${formatDistance(new Date(api.timestamp), new Date())}`)
    await discord(`@here API node ${api.node} is back up, it was down for ${formatDistance(new Date(api.timestamp), new Date())}`)
    await ntfy(`API node ${api.node} is back up, it was down for ${formatDistance(new Date(api.timestamp), new Date())}`)
  });

  // Process api nodes down
  const down = nodes.map(node => {
    // Find if this node was already down
    const oldDown = old.find(api => api.node === node);

    const timestamp = oldDown ? oldDown.timestamp : now;
    return { node, timestamp };
  });

  // Save api nodes down to db
  db.down = down;
  savedb();

  // Send alerts for down nodes
  down.map(async api => {
    // Was this node already down?
    if (api.timestamp !== now) {
      // Get the seconds down
      const secs = Math.round((now - api.timestamp) / 1000);

      // Find a trigger that fits if any
      const message = (config.apiwatcher.triggers.find(t => Math.abs(secs - t) < 30) !== undefined) || ((secs % config.apiwatcher.triggers[0]) < 30);

      // Send message?
      if (message && config.remind) {
        await telegram(`API node ${api.node} has been down for ${formatDistance(new Date(api.timestamp), new Date())}`);
        await discord(`API node ${api.node} has been down for ${formatDistance(new Date(api.timestamp), new Date())}`);
        await ntfy(`API node ${api.node} has been down for ${formatDistance(new Date(api.timestamp), new Date())}`);
      }
    } else if(now - api.timestamp > 5*60*1000) {
      await telegram(`API node ${api.node} went down`);
      await discord(`@here API node ${api.node} went down`);
      await ntfy(`API node ${api.node} went down`);
    }
  });

}


// helpers

const nextAPI = () => currentAPI < (config.apis.length - 1) ? currentAPI + 1 : 0;

const scheduleRetry = (action) => {
  currentAPI = nextAPI();
  if (retries++ < config.watcher.retries) {
    setTimeout(action, config.intervals.retry);
  } else {
    // Reached retries limit
    console.log('Reached the retries limit, giving up...');
    retries = 0;
  }
}

const update_db_leaders = async () => {
  return fetch(`${config.apis[currentAPI]}/rank/leaders`)
    .then(res => res.json())
    .then(leaders => {
      if (!leaders || !Array.isArray(leaders)) {
        console.log('Failed updating leaders data:', leaders);
        return;
      }
      db.leaders = leaders;
    })
    .catch (err => {
      console.error('Error updating leaders data');
      console.error(err);
    });
}

const get_api_nodes_down = async () => {
  db.isChainHalted = true;
  const down = await Promise.all(config.apiwatcher.nodes.map(async api => {
    try {
      await fetch(`${api}/count`, { timeout: 5000 }).then(async (res) => {
        let count = await res.json();
        //console.log(await count.count);
        if (res.ok) {
          await fetch(`${api}/block/${count['count']}`, { timeout: 10000 }).then(async (rawBlockData) => {
            rawBlockData = await rawBlockData.json();
            //console.log("block", rawBlockData);
            let blockData = rawBlockData;
            //console.log("Comparing times")
            if(blockData['timestamp']>(Date.now()-(60000*5))) {
              if (db.isChainHalted && (!db.chainRecoveredMessageSent || db.chainHaltedMessageSent)) {
                await telegram(`Chain running again! It was halted for about ${formatDistance(new Date(db.lastBlockTs), new Date())}`);
                await discord(`@here Chain running again! It was halted for about ${formatDistance(new Date(db.lastBlockTs), new Date())}`);
                await ntfy(`Chain running again! It was halted for about ${formatDistance(new Date(db.lastBlockTs), new Date())}`);
                db.isChainHalted = false;
                db.chainHaltedMessageSent = false;
                db.chainRecoveredMessageSent = true;
                db.sameBlockCounter = 0;
              } else {
                db.isChainHalted = false;
                //console.log("Chain apparently running")
              }
            }
            db.lastBlockTs = rawBlockData['timestamp'];
          })
        }
        savedb();
        return (!res.ok);
      })
    } catch (e) {
      console.error('API watcher node', api, 'fetch failed, reason:', e);
      return true;
    }
  }));
  if (db.isChainHalted) {
    db.sameBlockCounter = db.sameBlockCounter+1;
    console.log("Same block for check #"+db.sameBlockCounter+"...")
  } else {
    db.sameBlockCounter = 0;
  }
  if (db.isChainHalted && (!db.chainHaltedMessageSent || db.chainRecoveredMessageSent)) {
    await telegram(`Chain halted? All API nodes have old blocks. Last block ts: `+db.lastBlockTs + " about "+formatDistance(new Date(db.lastBlockTs), new Date())+" ago.");
    await discord(`@here Chain halted? All API nodes have old blocks. Last block ts: `+db.lastBlockTs + " about "+formatDistance(new Date(db.lastBlockTs), new Date())+" ago.");
    await ntfy(`Chain halted? All API nodes have old blocks. Last block ts: `+db.lastBlockTs + " about "+formatDistance(new Date(db.lastBlockTs), new Date())+" ago.");
    db.chainHaltedMessageSent = true;
    db.chainRecoveredMessageSent = false;
  }
  savedb();
	return config.apiwatcher.nodes.filter((_v, index) => down[index]);
}

const telegram = async (msg) => {
  if (config.telegram && config.telegram.apiurl && config.telegram.apikey && config.telegram.apikey !== '') {
    const body = {
      chat_id: config.telegram.chat,
      text: msg,
      parse_mode: 'markdown'
    };
    return fetch(`${config.telegram.apiurl}${config.telegram.apikey}/sendMessage`, {
      method: 'post',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json'
      }
    })
      .then(res => res.json())
      .then(json => {
        if (!json.ok) {
          console.log('Failed sending telegram message:', json);
        }
      })
      .catch (err => {
        console.error('Error sending telegram message');
        console.error(err)
      });
  } else {
    console.log('TM Message:', msg);
  }
}

const loaddb = () => {
  try {
    db = JSON.parse(fs.readFileSync(config.db));
  }
  catch (e) {
    console.log('Error loading DB:', e.message);
  }
}

const savedb = () => {
  try {
    fs.writeFileSync(config.db, JSON.stringify(db, null, 2));
  }
  catch (e) {
    console.log('Error saving DB:', e.message);
  }
}


const discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });

discordClient.on('ready', () => {
  console.log(`Logged in as ${discordClient.user.tag}!`);
});

async function discord(msg) {
  if (config.discord.enable && config.discord.token && config.discord.token !== '' && config.discord.token !== null) {
    // console.log(await discordClient.channels.fetch(config.discord.channels[0]))
    for (const channel in config.discord.channels) {
      try {
        let channelObj = await discordClient.channels.fetch(config.discord.channels[channel]);
        await channelObj.send(msg);
      } catch(err) {
        console.log(await err);
      }
    }
  } else {
    console.log("Discord MSG: "+msg);
  }
}

async function ntfy(msg) {
  if (config.ntfy.enable && config.ntfy.address && config.ntfy.address !== '')
    try {
    await fetch(config.ntfy.address, {
      method: 'POST', // PUT works too
      body: msg
    })
  } catch (err) {
    console.log(await err);
  }
}

// boot up the bot

// telegram('Avalon alerts bot starting...');
await discordClient.login(config.discord.token);

// await discord('Avalon alerts bot starting...');
// load the database
loaddb();

// start watcher
setInterval(watcher, config.intervals.watcher);

// start API watcher
setInterval(APIwatcher, config.intervals.apiwatcher);

// do 1st watcher round now
setImmediate(watcher);
setImmediate(APIwatcher);
