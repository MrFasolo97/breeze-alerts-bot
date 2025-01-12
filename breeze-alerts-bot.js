const fs = require('fs');
const fetch = require('node-fetch');
const formatDistance = require('date-fns/formatDistance');

const config = require('./config.json');


var currentAPI = 0;
var retries = 0;

var db = {
  down: [],
  missers: {},
  leaders: []
};


const watcher = async () => {
  try {
    // Save old leaders to compare
    const old = db.leaders;

    // Get new leaders data
    await update_db_leaders();

    // Alert leaders that unregistered
    old.filter(o => (db.leaders.find(l => l.name === o.name) === undefined)).map(async leader => await telegram(`Witness${candidate} \`${leader.name}\` unregistered`));

    // Actual missers
    const missers = Object.keys(db.missers);

    // Compare new leaders from db with old
    db.leaders.map(async (leader, index) => {
      // Check if this leader is producing or just a candidate
      const candidate = index < 13 ? '' : ' candidate';

      // Find the old leader
      const oldLeader = old.find(l => l.name === leader.name);

      // Leader not found in old leaders db?
      if (oldLeader === undefined) {
        await telegram(`Witness${candidate} \`${leader.name}\` registered`);
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
            await telegram(`Witness${candidate} \`${leader.name}\` ${action}, after missing *${total}* block(s), total blocks missed now is *${leader.missed}*`);
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
        if (message) {
          await telegram(`Witness${candidate} \`${leader.name}\` continues missing, now with *${total}* block(s) missed`);
          // Update last message missed in db
          misser.last = leader.missed;
          savedb();
        }
      } else {
        // Calc the misses
        const misses = leader.missed - (oldLeader.missed || 0);

        // Are there any misses?
        if (misses > 0) {
          // Add to missers in db
          db.missers[leader.name] = {
            produced: leader.produced,
            start: oldLeader.missed + 1,
            last: leader.missed
          };
          savedb();

          await telegram(`Witness${candidate} \`${leader.name}\` missed *${misses}* block(s)`);
        }
      }
    });

  } catch (e) {
    console.error('API node', config.apis[currentAPI], 'failed to retrieve witness data, reason:', e);
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
  old.filter(api => !nodes.includes(api.node)).map(async api => await telegram(`API node ${api.node} is back up, it was down for ${formatDistance(new Date(api.timestamp), new Date())}`));

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
      if (message) {
        await telegram(`API node ${api.node} has been down for ${formatDistance(new Date(api.timestamp), new Date())}`);
      }
    } else {
      await telegram(`API node ${api.node} went down`);
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
  return fetch(`${config.apis[currentAPI]}/rank/witnesses`)
    .then(res => res.json())
    .then(leaders => {
      if (!leaders || !Array.isArray(leaders)) {
        console.log('Failed updating witnesses data:', leaders);
        return;
      }
      db.leaders = leaders;
    })
    .catch (err => {
      console.error('Error updating witnesses data');
      console.error(err);
    });
}

const get_api_nodes_down = async () => {
  const down = await Promise.all(config.apiwatcher.nodes.map(async api => {
    try {
      const res = await fetch(`${api}/count`, { timeout: 5000 });

      return (!res.ok);
    } catch (e) {
      console.error('API watcher node', api, 'fetch failed, reason:', e);
      return true;
    }
  }));

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


// boot up the bot

// telegram('Avalon alerts bot starting...');

// load the database
loaddb();

// start watcher
setInterval(watcher, config.intervals.watcher);

// start API watcher
setInterval(APIwatcher, config.intervals.apiwatcher);

// do 1st watcher round now
setImmediate(watcher);
