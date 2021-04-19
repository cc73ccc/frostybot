// PNL calculation module

const frostybot_module = require('./mod.base')
var context = require('express-http-context')
const axios = require('axios')

module.exports = class frostybot_pnl_module extends frostybot_module {

   // Constructor

    constructor() {
        super()
        this.exchange = [];
    }


    // Load exchange for a given user uuid and stub

    async load_exchange(user, stub) {
        var accounts = await this.database.select('settings', {uuid: user, mainkey: 'accounts', subkey: stub});
        var encaccount = Array.isArray(accounts) && accounts.length == 1 && accounts[0].hasOwnProperty('value') ? JSON.parse(accounts[0].value) : {};
        var account = await this.utils.decrypt_values( this.utils.lower_props(encaccount), ['apikey', 'secret'])

        if (account) {
            if (account && account.hasOwnProperty (stub)) {
                account = account[stub];
            }
            const exchange_id = (account.hasOwnProperty('exchange') ? account.exchange : undefined);
            if (exchange_id == undefined) {
                return false;
            }
            this.exchange_id = exchange_id;
            var type = account.hasOwnProperty ('type') ? account.type : null;
            var ex_type = exchange_id + (type != null ? '.' + type : '');
            const exchange_class = require ('../exchanges/exchange.' + ex_type);
            var key = [user, stub].join(':');
            this.exchange[key] = new exchange_class (stub, user);
            return true;
        }
        return false;
    }

    // Import orders for every user, stub and symbol

    async import_orders(params) {

        var schema = {
            user:        { optional: 'string', format: 'lowercase', },
            stub:        { optional: 'string' },
            market:      { optional: 'string', format: 'uppercase' },
            days:        { optional: 'number' },
        }        

        if (!(params = this.utils.validator(params, schema))) return false; 

        var [user, stub, market, days] = this.utils.extract_props(params, ['user', 'stub', 'market', 'days']);
        var url = await global.frostybot._modules_['core'].url();

        if (user == undefined) {

            // User is undefined

            var users = await this.database.select('users');

            if (Array.isArray(users)) {
                users.forEach(item => {
                    var uuid = context.get('uuid');
                    var user = item.uuid;

                    var payload = {
                        uuid        : uuid,
                        command     : 'pnl:import_orders',
                        user        : user,
                        days        : days
                    }

                    axios.post(url + '/frostybot',  payload);
                });
            }

            return true;
            
        } else {

            // User is defined

            if (stub == undefined) {

                // Stub is not defined

                var stubs = await this.database.select('settings', {uuid: user, mainkey: 'accounts'});

                if (Array.isArray(stubs)) {
                    stubs.forEach(item => {
                        var uuid = context.get('uuid');
                        var stub = item.subkey;
    
                        var payload = {
                            uuid        : uuid,
                            command     : 'pnl:import_orders',
                            user        : user,
                            stub        : stub,
                            days        : days
                        }
    
                        try {
                            axios.post(url + '/frostybot',  payload);
                        } catch(e) {
                            this.output.exception(e);
                        }

                    })
                }

                return true;
    
            } else {


                // Stub is defined

                //this.cache.flush(true);
                
                var key = [user, stub].join(':');
                await this.load_exchange(user, stub);
            
                if (this.exchange[key] != false) {

                    if (market == undefined) {
                        var symbols = this.exchange[key].orders_symbol_required ? await this.exchange[key].execute('symbols') : ['<ALL>'];
                    } else {
                        var symbols = Array.isArray(market) ? market : [market];
                    }
                    

                    if (Array.isArray(symbols)) {
                        
                        var total = 0;

                        for (var i = 0; i < symbols.length; i++) {
                            var symbol = symbols[i];

                            params.market = symbol;
                            var order_history = await this.order_history(user, stub, symbol, days);
                            var qty = Array.isArray(order_history) ? order_history.length : 0;
                            //console.log(stub +': ' + symbol + ': ' + qty)
                            total += qty;

                            if (Array.isArray(order_history)) {
                                order_history.forEach(order => {
                                    this.update_order(user, stub, order);
                                });
                            }

                            /*
                            var uuid = context.get('uuid');    
                            var payload = {
                                uuid        : uuid,
                                command     : 'pnl:import_orders',
                                user        : user,
                                stub        : stub,
                                market      : symbol,
                                days        : days
                            }

                            axios.post(url + '/frostybot',  payload);
                            await this.utils.sleep(1);
                            */

                        }

                        var importstats = {
                            user: user,
                            stub: stub,
                            total: total,
                        }

                        this.output.debug('orders_imported', importstats);

                        return true;

                    }

                }
                
            }

        }



        
    }

    // Get order history for a given user uuid, stub, symbol and days


    async order_history(user, stub, symbol, days = 7) {

        var ms = 1000 * 60 * 60 * 24 * days
        var ts = Date.now() - ms;
        var all_orders = {};
        var order_params = { 
            stub: stub,
            since: ts
        }

        if (!['<ALL>',undefined].includes(symbol)) order_params['symbol'] = symbol;

        var key = [user, stub].join(':');
        
        if (this.exchange[key] == false)
            return false;

        var orders =  await this.exchange[key].execute('order_history', order_params, true);

        while (orders.length > 0) {

            orders = orders.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1)
            var batch_ts = {
                standard: 0,
                conditional: 0
            }

            for (var i = 0; i < orders.length; i++) {

                var order = orders[i];
                if (!all_orders.hasOwnProperty(order.id)) {
                    all_orders[order.id] = order;
                }

                if (['market','limit'].includes(order.type)) {
                    if (order.timestamp > batch_ts.standard) {
                        batch_ts.standard = order.timestamp;
                    } 
                } else {
                    if (order.timestamp > batch_ts.conditional) {
                        batch_ts.conditional = order.timestamp;
                    } 
                }

            }

            if (batch_ts.standard == 0) batch_ts.standard = batch_ts.conditional;
            if (batch_ts.conditional == 0) batch_ts.conditional = batch_ts.standard;

            var mints = Math.min(batch_ts.standard, batch_ts.conditional);
            if (mints == 0) break;

            order_params.since = mints + 1;
            orders =  await this.exchange[key].execute('order_history', order_params, true);
        }

        return Object.values(all_orders);

    }


    // Update order in the database

    async update_order(user, stub, order) {
        order.uuid = user
        order.stub = stub
        order.orderid = order.id
        order.order_price = order.price
        order.trigger_price = order.trigger
    
        delete order.id
        delete order.price
        delete order.trigger
        delete order.datetime

        var existing = await this.database.select('orders', {uuid: user, stub: stub, orderid: order.id});
        if (Array.isArray(existing && existing.length == 1)) {                                
            order = {...existing, ...order};
        }
    
        if (!order.hasOwnProperty('size_usd')) order['size_usd'] = 0
        if (!order.hasOwnProperty('size_usd')) order['size_usd'] = 0
        if (!order.hasOwnProperty('filled_usd')) order['filled_usd'] = 0

        await this.database.insertOrReplace('orders', order);
    }


    // Generate PNL report data from order history in database

    
    async get_data(params) {

        var schema = {
            stub:        { required: 'string', format: 'lowercase', },
            user:        { optional: 'string', format: 'lowercase', },
            symbol:      { optional: 'string', format: 'uppercase', },
            days:        { required: 'number' },
        }

        if (!(params = this.utils.validator(params, schema))) return false; 

        var [user, stub, symbol, days] = this.utils.extract_props(params, ['user', 'stub', 'symbol', 'days']);
        
        if (user == undefined) { user = context.get('uuid') }
    
//        var position = await this.exchange_execute(stub, 'position',params);
        
        //var orders =  await this.exchange_execute(stub, 'orders',params);
        
        var query =  {uuid: user, stub: stub};

        if (symbol != undefined) query['symbol'] = symbol;
        
        var ms = 1000 * 60 * 60 * 24 * days
        var ts = Date.now() - ms;

        var vals = [
            user,
            stub,
            ts
        ];
        var sql = "SELECT * FROM `orders` WHERE uuid=? AND stub=? AND timestamp>=?";
        if (symbol != undefined) {
            sql += " AND `symbol`=?";
            vals.push(symbol)
        }

        var orders = await this.database.query(sql, vals);

        var orders_by_symbol = {};

        if (Array.isArray(orders) && orders.length > 0) {
            for (var i = 0; i < orders.length; i++) {
                var order = orders[i];
                delete order.metadata;
                if (!orders_by_symbol.hasOwnProperty(order.symbol)) orders_by_symbol[order.symbol] = [];
                orders_by_symbol[order.symbol].push(order);
            }    
        } else {
            return {};
        }

        var symbols = Object.keys(orders_by_symbol);
        var pnl_by_symbol = {}

        symbols.forEach(symbol => {

            var orders = orders_by_symbol[symbol].sort((a, b) => a.timestamp > b.timestamp ? -1 : 1).filter(order => order.filled_base > 0)

            // Check if currently in a position, if so use the position balance for unrealized PNL calc
            //var bal_base = this.utils.is_object(position) && position.hasOwnProperty('base_size') ? position.base_size : 0;
            //var bal_quote = this.utils.is_object(position) && position.hasOwnProperty('quote_size') ? position.quote_size : 0;
        
            var bal_base = 0;
            var bal_quote = 0;

            // Cycle backwards through orders and reconstruct balance and group orders for the same position together
            var groups = [];
            var current = [];
     
            for(var n = 0; n < orders.length; n++) {
                var order = orders[n];
                var entry = order;
                delete entry.trigger;
                delete entry.status;
                entry.balance_base = bal_base;
                entry.balance_quote = bal_base * order.order_price,
                current.push(entry);
                bal_base = (order.direction == 'sell' ? bal_base + order.filled_base : bal_base - order.filled_base);
                bal_quote = (order.direction == 'sell' ? bal_quote + order.filled_quote : bal_quote - order.filled_quote);
                if (bal_base == 0) {
                    var start = order.timestamp;
                    var end = [undefined, start].includes(current[0]) || current.length < 2 ? null : current[0].timestamp;
                    var group = {
                        start: start,
                        end: end,
                        pnl: bal_quote,
                        orders: current.sort((a, b) => a.timestamp < b.timestamp ? -1 : 1)
                    }
                    groups.push(group);
                    current = [];
                    bal_quote = 0
                }
            }
    
            // Sort order groups cronologically
            groups.sort((a, b) => a.start < b.start ? -1 : 1)
    
            pnl_by_symbol[symbol] = new this.classes.pnl(stub, symbol, groups); 


        });

        return pnl_by_symbol;

    }


}