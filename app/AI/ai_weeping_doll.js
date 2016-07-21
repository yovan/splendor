import _ from 'underscore';
import {
  hasEnoughResourceForCard,
  flattenResources,
  zipResources,
} from './helpers';
import { canBuyCard } from 'app/validates';

import Combinatorics from 'js-combinatorics';

import model from './nn_model';

const debug = require('debug')('app/AI/ai_weeping_doll');

const colors = [
  'white', 'blue', 'green', 'red', 'black'
];

const TRAINING = false;
const LEARNING_RATE = 0.01;
const EPSILON = 0.6;


function normalize(max, value) {
  return Math.min((value || 0) / max, 1);
}

function encodePlayer(player) {
  let features = [];
  // encode player state
  colors.forEach(color => {
    features.push(normalize(10, player.bonus[color]));
  });
  colors.forEach(color => {
    features.push(normalize(10, player.resources[color]));
  });
  features.push(normalize(10, player.resources.gold));

  for(let i = 0; i < 3; i++) {
    features = features.concat(encodeCard(player.reservedCards[i] || {}));
  }
  return features;
}

function encodeCard(card) {
  let features = [];
  // cost
  colors.forEach(color => {
    features.push(normalize(10, card[color]));
  });
  // provides bonus
  colors.forEach(color => {
    var provide = (card.provide == color) ? 1 : 0;
    features.push(provide);
  });
  // score
  features.push(normalize(10, card.points));
  return features;
}

function encodeNoble(noble) {
  let features = [];
  // cost
  colors.forEach(color => {
    features.push(normalize(10, noble[color]));
  });
  // score
  features.push(normalize(10, noble.points));
  return features;
}

function encodeGameState(game) {
  const { player, players, cards, nobles, resources, deckRemaingings } = game;
  let features = [];

  features = features.concat(encodePlayer(player));

  // TODO encode other player's state

  // cards on board
  for(let i = 0; i < 12; i++) {
    features = features.concat(encodeCard(cards[i] || {}));
  }

  // nobles
  for(let i = 0; i < 5; i++) {
    features = features.concat(encodeNoble(nobles[i] || {}));
  }

  // cards remaining in each deck
  for(let i = 0; i < 3; i++) {
    features.push(normalize(40, deckRemaingings[i]));
  }

  // resources
  colors.forEach(color => {
    features.push(normalize(10, resources[color]));
  });
  features.push(normalize(10, resources.gold));

  return features;
}

function encodeAction(action) {
  const { action: actionName } = action;
  let features = [];
  if(actionName == 'buy') {
    features = features.concat(encodeCard(action.card));
  } else {
    features = features.concat(encodeCard({}));
  }
  if(actionName == 'hold') {
    features = features.concat(encodeCard(action.card));
  } else {
    features = features.concat(encodeCard({}));
  }
  colors.forEach(color => {
    features.push(normalize(10, (action.resources || {})[color]));
  });
  return features;
}

function evalPlayer(player) {
  let score = player.score;

  let colorScore = 0;
  colors.forEach(color => {
    colorScore += normalize(100, player.bonus[color]);
    colorScore += normalize(200, player.resources[color]);
  });
  colorScore += normalize(150, player.resources.gold);

  let holdScore = 0;
  player.reservedCards.forEach(card => {
    holdScore += normalize(1000, card.points);
  });
  // debug(score, colorScore, holdScore);
  return score + colorScore + holdScore;

}

function playerBoughtCard(player, state, card) {
  if(!canBuyCard(player, card)) {
    return player;
  }

  const bonus = Object.assign({}, player.bonus, {
    [card.provides]: player.bonus[card.provides] + 1
  });

  let resources = Object.assign({}, player.resources);
  colors.forEach(color => {
    const pay = Math.max(card[color] - player.bonus[color], 0);
    const short = player.resources[color] - pay;
    if(short < 0) {
      resources[color] = 0;
      resources.gold += short;
    } else {
      resources[color] -= pay;
    }
  });

  return Object.assign({}, player, {
    bonus,
    resources,
  });
}

function playerTakeResources(player, state, resources) {
  let futureResources = Object.assign({}, player.resources);
  colors.forEach(color => {
    futureResources[color] += resources[color];
  });
  return Object.assign({}, player, {
    resources: futureResources
  });
}

function playerHoldCard(player, state, card) {
  let resources = Object.assign({}, resources);
  resources.gold += 1;
  return Object.assign({}, player, {
    resources,
    reservedCards: player.reservedCards.concat(card),
  });
}

// TODO those functions should return whole changed state
function predictState(state, action) {
  const { player } = state;
  const { action: actionName } = action;
  if(actionName == 'buy') {
    return playerBoughtCard(player, state, action.card);
  } else if(actionName == 'hold') {
    return playerHoldCard(player, state, action.card);
  } else {
    return playerTakeResources(player, state, action.card);
  }
}

function mse(v, expected) {
  return Math.pow(expected - v, 2) / 2;
}

export default class WeepingDoll {
  constructor (store, playerIndex, playerCount, winGameScore) {
    this.store = store;
    this.playerIndex = playerIndex;
    this.playerCount = playerCount;
    this.winGameScore = winGameScore;


    this.prevFeatures = null;
  }

  getAllActions(state) {
    const { player } = state;
    let actions = [];

    const allCards = state.cards.concat(player.reservedCards);
    const affordableCards = getAffordableCards(player, allCards);

    actions = actions.concat(affordableCards.map(card => {
      return {
        action: 'buy',
        card,
      };
    }));

    const availableColors = colors.filter(color => {
      return state.resources[color] > 0;
    });

    let cmb = Combinatorics.combination(availableColors, 3);
    for(let res = cmb.next(); res; res = cmb.next()) {
      actions.push({
        action: 'resource',
        resources: zipResources(res),
      });
    }

    actions = actions.concat(state.cards.map(card => {
      return {
        action: 'hold',
        card,
      };
    }));

    return actions;
  }

  turn (state) {
    const { player } = state;
    // if(TRAINING) {
    //   const action = this.chooseAction(state);

    //   if(this.prevFeatures) {
    //     const value = normalize(20, evalPlayer(player));
    //     const eValue = this.net.activate(this.prevFeatures);

    //     let futurePlayer;
    //     if(action.action == 'buy') {
    //       futurePlayer = playerBoughtCard(player, action.card);
    //     } else if(action.action == 'hold') {
    //       futurePlayer = playerHoldCard(player, action.card);
    //     } else {
    //       futurePlayer = playerTakeResources(player, action.resources);
    //     }
    //     const fValue = normalize(20, evalPlayer(futurePlayer));

    //     this.net.propagate(LEARNING_RATE, [value + 0.9 * fValue]);
    //     debug(mse(value + 0.9 * fValue, eValue));
    //   }
    //   this.prevFeatures = encodeGameState(state).concat(encodeAction(action));
    //   return action;
    // }

    const actions = this.getAllActions(state);
    let action;
    if(Math.random() > EPSILON) { // take best action
      action = actions.sort((actionA, actionB) => {
        const gameFeatures = encodeGameState(state);
        const featureA = gameFeatures.concat(encodeAction(actionA));
        const featureB = gameFeatures.concat(encodeAction(actionB));
        const vA = model.net.activate(featureA)[0];
        const vB = model.net.activate(featureB)[0];
        return vB - vA;
      })[0];
    } else { // take a random move
      action = actions[Math.floor(Math.random() * actions.length)];
    }
    let futurePlayer;
    if(action.action == 'buy') {
      futurePlayer = playerBoughtCard(player, action.card);
    } else if(action.action == 'hold') {
      futurePlayer = playerHoldCard(player, action.card);
    } else {
      futurePlayer = playerTakeResources(player, action.resources);
    }
    return action;
  }

  dropResources (state, resources) {
    return zipResources(_.shuffle(flattenResources(resources)).slice(0, 10));
  }

  pickNoble (state, nobles) {
    return nobles[0];
  }

  end (state) {
    if(TRAINING) {
      model.exportModel();
    }
  }
}

// some helper functions

function countResources (resources) {
  return Object.keys(resources).reduce((total, k) => {
    return total + resources[k];
  }, 0);
}

function getAffordableCards(player, cards) {
  return cards.filter(hasEnoughResourceForCard.bind(null, player));
}

function cardCost(player, card) {
  let shortOf = 0;
  let cost = 0;
  colors.forEach(color => {
    var short = card[color]
      - player.resources[color]
      - player.bonus[color];
    cost += Math.max(0, card[color] - player.bonus[color]);
    if(short > 0) {
      shortOf += short;
    }
  });
  return shortOf + cost;
}

function calcAllBonus(cards) {
  const allBonus = cards.reduce((bonus, card) => {
    colors.forEach(color => {
      bonus[color] += card[color] * (4 - card.rank);
    });
    return bonus;
  }, {
    white: 0,
    blue: 0,
    green: 0,
    red: 0,
    black: 0,
  });

  return allBonus;
}

function cardValue(player, card) {
  const w1 = 1.5 * (15 - player.score) / 15;
  const w2 = player.score / 15;
  const weight = w1 * (1 / (1 + cardCost(player, card))) +
    w2 * card.points;
  return weight;
}

function getBestCard(player, cards) {
  const sortedCards = cards.sort((cardA, cardB) => {
    return cardValue(player, cardB) - cardValue(player, cardA);
  });
  return sortedCards[0];
}