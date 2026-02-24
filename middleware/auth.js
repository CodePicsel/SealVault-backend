const jwt = require('jsonwebtoken')

module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if(!authHeader || !authHeader.startwith('Bearer '))
        return res.status(401).json({message:'No token provided'});
    const token = authHeader.split(' ')[1];
    try{
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = { id: decoded.userId};
        next();
    }catch(err){
        return res.status(401).json({message: 'Invalid or Expired Token'});
    }
};