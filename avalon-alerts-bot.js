const fs = require('fs');
const fetch = require('node-fetch');

const config = require('./config.json');


var currentEndpoint = 0;
var retries = 0;

var db = [];


const watcher = async () => {
  console.log('Watcher starting');

  try {
    // Save old db to compare
    const old = db;

    // Get new leaders data
    await update_db_leaders();

    // Compare new db with old
    db.map(leader => {
      // Find the old leader
      const oldLeader = old.find(l => l.name === leader.name) || {};

      // Calc the misses
      const misses = leader.missed - (oldLeader.missed || 0);

      // Are there any misses?
      if (misses != 0) {
        telegram(`Leader \`${leader.name}\` missed *${misses}* block(s), total blocks missed now is *${leader.missed}*`);
      }
    });

  } catch (e) {
    console.error('Endpoint', config.endpoints[currentEndpoint], 'failed to retrieve leader data, reason:', e);
    // Retry the watcher because this might happen due to communication errors with the node...
    console.log('Retrying the watcher in a bit...');
    scheduleRetry(watcher);
    return;
  }

  savedb();

  console.log('Watcher done, sleeping for a while...');
}

// helpers

const nextEndpoint = () => currentEndpoint < (config.endpoints.length - 1) ? currentEndpoint + 1 : 0;

const scheduleRetry = (action) => {
  currentEndpoint = nextEndpoint();
  if (retries++ < config.action.retries) {
    setTimeout(action, config.intervals.retry);
  } else {
    // Reached retries limit
    console.log('Reached the retries limit, giving up...');
    retries = 0;
  }
}

const update_db_leaders = async () => {
  return fetch(`${config.endpoints[currentEndpoint]}`)
    .then(res => res.json())
    .then(leaders => {
      if (!leaders || !Array.isArray(leaders)) {
        console.log('Failed updating leaders data:', json);
        return;
      }
      db = leaders;
    })
    .catch (err => {
      console.error('Error updating leaders data');
      console.error(err)
    });
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

// do 1st watcher round now
setImmediate(watcher);
