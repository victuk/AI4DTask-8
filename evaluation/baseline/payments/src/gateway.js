const stripe = require('stripe')(process.env.STRIPE_KEY);
module.exports = { charge: (params) => stripe.charges.create(params) };
