# Test PNL calculation manually
qty = 0.001
price = 89000
exit_price = 89500
slip_fraction = 0.0003
comm_fraction = 0.001
is_long = True

eff_entry = price * (1.0 + slip_fraction)
eff_exit  = exit_price * (1.0 - slip_fraction)

raw_pnl = (eff_exit - eff_entry) * qty

entry_notional = eff_entry * qty
exit_notional  = eff_exit  * qty
commission_cost = (entry_notional + exit_notional) * comm_fraction

pnl = raw_pnl - commission_cost
print(f"PNL: {round(pnl, 2)}")

