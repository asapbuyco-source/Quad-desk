for f in ['test_trade_execution.py', 'test_integration_e2e.py']:
    try:
        with open(f, 'r', encoding='utf-8') as file:
            data = file.read()
        data = data.replace('exchange_id="binance"', 'exchange_id="binanceusdm"')
        data = data.replace('ccxt.binance', 'ccxt.binanceusdm')
        with open(f, 'w', encoding='utf-8') as file:
            file.write(data)
        print(f"Updated {f}")
    except Exception as e:
        print(e)
