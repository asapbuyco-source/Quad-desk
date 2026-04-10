"""
Railway IP Finder
=================
Deploy this temporarily to Railway to discover the outbound IP
that Binance will see when the bot makes API requests.

After you get the IP, whitelist it in Binance API Management,
then remove this file and redeploy normally.
"""
import urllib.request

try:
    ip = urllib.request.urlopen("https://api.ipify.org", timeout=8).read().decode()
    print(f"==============================================")
    print(f"  Railway server outbound IP: {ip}")
    print(f"  Add this IP to Binance API whitelist.")
    print(f"==============================================")
except Exception as e:
    print(f"Could not fetch IP: {e}")
